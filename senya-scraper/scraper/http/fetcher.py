"""
The reusable fetcher every adapter goes through.

One object owning everything that makes a request look like a person, so no
adapter has to remember any of it and none of them can drift apart:

    profile      which browser we are (TLS + HTTP/2 + headers, consistently)
    pacing       jittered gaps, per domain, shared across threads
    session      persistent cookie jar, warm-up navigation, Referer chains
    resilience   retries with backoff, block detection
    transport    swappable backend (curl_cffi → requests)

Everything is set by `FetchPolicy`, so a site that needs different behaviour
changes data, not code:

    class Kijiji(Scraper):
        policy = FetchPolicy(profile="chrome-win", min_interval=3, max_interval=9)

Adding a knob means one field here and one place that reads it.
"""

from __future__ import annotations

import logging
import os
import random
import threading
import time
from dataclasses import dataclass, field

from . import backends as backend_registry
from . import profiles as profile_registry

log = logging.getLogger(__name__)


class FetchError(Exception):
    """Transport-level failure, already phrased for a human."""


class BlockedError(FetchError):
    """The site answered, but with a challenge/among-the-bots page rather than
    content. Separate because the remedy is different: wait, do not debug."""


@dataclass
class FetchPolicy:
    """Everything tunable about how a site is fetched."""

    profile: str = profile_registry.DEFAULT_PROFILE
    backend: str | None = None          # None = best available

    # ---- pacing ----
    # A fixed delay is itself a signature: humans do not click at exactly 1.5s
    # intervals. When max_interval is set, each gap is drawn from [min, max]
    # with a bias toward the short end, which is roughly how real browsing looks.
    min_interval: float = 1.5
    max_interval: float | None = 5.0

    # ---- resilience ----
    retries: int = 2
    backoff: float = 4.0                # seconds, doubled each retry
    timeout: int = 25

    # ---- session realism ----
    #: Fetch this before the first real request, to pick up cookies the way a
    #: person landing on the homepage would. Also what makes a later Referer
    #: honest rather than invented.
    warmup_url: str = ""
    #: Persist cookies here between restarts. A brand-new jar on every process
    #: start is a returning-visitor signal no real browser sends.
    cookie_file: str = ""
    #: Send Referer + Sec-Fetch-Site: same-origin once the session is warm.
    referer_chain: bool = True

    proxy: str | None = None
    verify: bool = True

    #: Predicates run on every 200. (name, fn(text, response) -> message | None)
    #: Lets a site declare its own "this is a challenge page" test without the
    #: fetcher knowing anything about it.
    detectors: tuple = field(default_factory=tuple)


class Pacer:
    """Per-domain gaps with jitter, shared process-wide.

    Global rather than per-session on purpose: two adapters or two browser tabs
    hitting the same host should still add up to a civil rate.
    """

    def __init__(self):
        self._last = {}
        self._locks = {}
        self._guard = threading.Lock()

    def _lock(self, domain):
        with self._guard:
            return self._locks.setdefault(domain, threading.Lock())

    def wait(self, domain, low, high=None):
        with self._lock(domain):
            gap = self._delay(low, high)
            elapsed = time.monotonic() - self._last.get(domain, 0.0)
            if elapsed < gap:
                time.sleep(gap - elapsed)
            self._last[domain] = time.monotonic()

    @staticmethod
    def _delay(low, high):
        if not high or high <= low:
            return low
        # Triangular with the mode at the short end: mostly brisk, occasionally
        # slow, never metronomic.
        return random.triangular(low, high, low + (high - low) * 0.3)


PACER = Pacer()


class Fetcher:
    """A browser-shaped HTTP client for one site."""

    def __init__(self, domain, policy=None):
        self.domain = domain
        self.policy = policy or FetchPolicy()
        self.profile = profile_registry.get(self.policy.profile)
        self.backend_cls = backend_registry.select(self.policy.backend)
        self.backend = self.backend_cls(self.profile, self.policy.proxy,
                                        self.policy.verify)
        self._warmed = False
        self._lock = threading.Lock()
        self._load_cookies()

    # ---- description, for /api/health ----

    def describe(self):
        return {
            "backend": self.backend_cls.key,
            "impersonates": self.backend_cls.impersonates,
            "profile": self.profile.key,
            "profile_label": self.profile.label,
            "tls_target": self.profile.impersonate,
            "min_interval": self.policy.min_interval,
            "max_interval": self.policy.max_interval,
            "cookies_persisted": bool(self.policy.cookie_file),
            "proxy": bool(self.policy.proxy),
        }

    # ---- cookies ----

    def _load_cookies(self):
        path = self.policy.cookie_file
        if not path or not os.path.exists(path):
            return
        try:
            import json
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict) and data:
                self.backend.set_cookies(data, f".{self.domain.removeprefix('www.')}")
                # A restored jar is already a warm session; re-running warm-up
                # would be the thing a real returning browser does not do.
                self._warmed = True
                log.info("%s: restored %d cookies", self.domain, len(data))
        except Exception:                           # noqa: BLE001
            log.debug("%s: could not restore cookies", self.domain, exc_info=True)

    def save_cookies(self):
        path = self.policy.cookie_file
        if not path:
            return
        try:
            import json
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            jar = self.backend.cookies()
            if not jar:
                return
            tmp = f"{path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(jar, fh)
            os.replace(tmp, path)                   # atomic; never a half file
            os.chmod(path, 0o600)                   # a jar is a credential
        except Exception:                           # noqa: BLE001
            log.debug("%s: could not persist cookies", self.domain, exc_info=True)

    # ---- fetching ----

    def warmup(self):
        """Land on the homepage first, like someone who typed the domain.

        Several sites (eBay, Facebook) refuse a cold hit on a deep search URL
        but hand out a session here. It also makes the Referer on the next
        request true rather than fabricated.
        """
        if self._warmed or not self.policy.warmup_url:
            return
        self._warmed = True                         # attempt once, even on failure
        try:
            self._raw("GET", self.policy.warmup_url,
                      self.profile.headers(site="none"))
            self.save_cookies()
        except FetchError:
            log.debug("%s: warm-up failed, continuing", self.domain)

    def get(self, url, referer=None, navigation=True, **kw):
        """A paced, retried, browser-shaped GET."""
        with self._lock:
            self.warmup()
        # After warm-up the natural story is "clicked through from the site",
        # so say so — and only then, since Sec-Fetch-Site: same-origin with no
        # prior request is exactly the inconsistency this all exists to avoid.
        if self.policy.referer_chain and self._warmed and self.policy.warmup_url:
            referer = referer or self.policy.warmup_url
            site = "same-origin"
        else:
            site = "none"
        headers = self.profile.headers(navigation=navigation, site=site,
                                       referer=referer)
        return self._with_retries("GET", url, headers, **kw)

    def _with_retries(self, method, url, headers, **kw):
        attempt, delay = 0, self.policy.backoff
        while True:
            try:
                res = self._raw(method, url, headers, **kw)
                self._check(res)
                self.save_cookies()
                return res
            except BlockedError:
                # Retrying immediately into a challenge only deepens the hole.
                raise
            except FetchError:
                if attempt >= self.policy.retries:
                    raise
                attempt += 1
                time.sleep(delay)
                delay *= 2

    def _raw(self, method, url, headers, **kw):
        PACER.wait(self.domain, self.policy.min_interval, self.policy.max_interval)
        try:
            res = self.backend.request(method, url, headers=headers,
                                       timeout=kw.pop("timeout", self.policy.timeout),
                                       **kw)
        except Exception as e:                      # noqa: BLE001
            raise FetchError(f"Could not reach {self.domain}: {e}") from e
        if res.status_code == 403:
            raise BlockedError(
                f"{self.domain} refused the request (403) — its bot protection "
                f"tripped. Waiting a few minutes usually clears it.")
        if res.status_code == 429:
            raise BlockedError(f"{self.domain} is rate limiting us (429). Slow down.")
        if res.status_code >= 400:
            raise FetchError(f"{self.domain} returned HTTP {res.status_code}.")
        return res

    def _check(self, res):
        """Run the site's own challenge-page detectors.

        These matter because the interesting failures arrive as HTTP 200: eBay's
        "Pardon Our Interruption" and Facebook's logged-out shell are both
        perfectly valid responses containing no data.
        """
        text = None
        for name, fn in self.policy.detectors:
            if text is None:
                text = res.text
            message = fn(text, res)
            if message:
                raise BlockedError(message)

    def close(self):
        self.save_cookies()
        self.backend.close()


def build(domain, policy=None):
    return Fetcher(domain, policy)
