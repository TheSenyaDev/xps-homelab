"""
Base class every marketplace adapter builds on, plus the bits they all share.

An adapter should read as a description of one site: which URL its search lives
at, and how to pull fields out of its HTML. Politeness, session priming, retries,
error shaping and price parsing are all here so they cannot drift between sites.

Subclasses register themselves just by existing — see `__init_subclass__` — so
adding a site is one new file in this package and no edit anywhere else.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import re
import threading
import time
from dataclasses import asdict, dataclass, field

import requests

from .. import http
from ..http import FetchPolicy

log = logging.getLogger(__name__)

class ScrapeError(Exception):
    """Anything that stops us returning listings. The message reaches the UI, so
    it should say what a person can do about it."""


class UnknownSite(ScrapeError):
    """Asked for a site this install does not have. A caller mistake (400), not
    an upstream failure (502) — kept separate so the API can tell them apart."""


@dataclass
class Listing:
    """One product, normalised across sites so the frontend never special-cases.

    `uid` is what dedupe and new-listing detection key on: it must be stable for
    the same item across runs, which rules out the URL — sites append per-search
    tracking params that change every time.
    """

    uid: str
    site: str
    title: str
    url: str
    price: float | None = None          # None = "see listing" / a range
    currency: str = "CAD"
    price_text: str = ""                # exactly as shown, e.g. "C $854.05"
    condition: str = ""
    shipping: str = ""
    location: str = ""
    seller: str = ""        # as displayed, e.g. "acme-parts 99.2% positive (431)"
    seller_name: str = ""   # just the account, for blocklist matching
    image: str = ""
    posted_at: str = ""                 # site's own timestamp, when it gives one
    extra: dict = field(default_factory=dict)

    def as_dict(self):
        return asdict(self)


@dataclass(frozen=True)
class Option:
    """One site-specific search control.

    The shared `SearchOptions` fields (query, sort, condition, price) exist
    because every marketplace has them. Everything a site can filter by that
    others cannot — eBay's buying format, a car site's mileage — is declared
    here instead, and the UI renders the controls from this description. That
    way adding a filter is a line in one adapter, with no frontend change and
    no field that other sites have to ignore.

    `type` is one of: bool · choice · text · number.
    `choices` is [(value, label)], required for `choice`.
    """

    key: str
    label: str
    type: str = "bool"
    choices: tuple = ()
    default: object = None
    help: str = ""

    def as_dict(self):
        return {
            "key": self.key, "label": self.label, "type": self.type,
            "choices": [{"value": v, "label": l} for v, l in self.choices],
            "default": self.default, "help": self.help,
        }

    def coerce(self, value):
        """Normalise a value that arrived as JSON or a form string."""
        if value is None:
            return self.default
        if self.type == "bool":
            return value not in (False, 0, "0", "false", "", None)
        if self.type == "number":
            try:
                return float(value)
            except (TypeError, ValueError):
                return self.default
        if self.type == "choice":
            allowed = {v for v, _ in self.choices}
            return value if value in allowed else self.default
        return str(value)


@dataclass(frozen=True)
class Sort:
    """One ordering a site offers.

    Sites do not agree on what orderings exist — eBay separates "Price" from
    "Price + shipping" and has "ending soonest" for auctions; Facebook has
    neither. So each adapter declares its own, and the UI shows exactly what
    that market can do instead of a lowest-common-denominator list.

    `kind` is the canonical meaning, used only when merging results from
    several markets, where site-specific keys cannot be compared. One of:
    best · newest · ending · price-asc · price-desc.
    """

    key: str            # site-specific id, e.g. "price-ship-asc"
    label: str          # shown in the UI
    value: str = ""     # the site's own code, e.g. eBay's _sop
    kind: str = "best"  # canonical, for cross-market merging

    def as_dict(self):
        return {"key": self.key, "label": self.label, "kind": self.kind}


@dataclass(frozen=True)
class Category:
    """One entry in a site's category tree. Sites number their categories
    differently (eBay has _sacat ids, Kijiji has path slugs), so `value` is
    whatever that site needs and only its own adapter interprets it."""

    key: str
    label: str
    value: str = ""


@dataclass(frozen=True)
class SearchOptions:
    """Everything a search can be narrowed by, in one object.

    A dataclass rather than **kwargs so adding an option (distance, seller type,
    date posted) is one field here plus handling in whichever adapters support
    it — and adapters that do not simply ignore it instead of raising.
    """

    query: str = ""
    sort: str = "best"
    condition: str = "any"
    category: str = ""
    min_price: float | None = None
    max_price: float | None = None
    page: int = 1

    #: Site-specific values, keyed by that site's `Option.key`. Kept in its own
    #: dict rather than as fields so one site's filters never leak into another's
    #: signature — an adapter reads only the keys it declared.
    params: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, src):
        def num(key):
            v = src.get(key)
            if v in (None, "", "null"):
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        params = src.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        return cls(
            query=(src.get("query") or "").strip(),
            sort=src.get("sort") or "best",
            condition=src.get("condition") or "any",
            category=src.get("category") or "",
            min_price=num("min_price"),
            max_price=num("max_price"),
            page=int(src.get("page") or 1),
            params=dict(params),
        )

    def param(self, key, default=None):
        return self.params.get(key, default)

    def replace(self, **changes):
        """A copy with fields overridden — the class is frozen, and a combined
        search needs one variant per site (each with only its own params)."""
        return dataclasses.replace(self, **changes)


# ----- shared parsing -----

_PRICE_RE = re.compile(r"(\d[\d,\s]*(?:\.\d{1,2})?)")
_CURRENCY_HINTS = (("US $", "USD"), ("US$", "USD"), ("CAD", "CAD"), ("C $", "CAD"),
                   ("EUR", "EUR"), ("€", "EUR"), ("£", "GBP"))


def parse_price(text):
    """('C $1,234.56') -> (1234.56, 'CAD').

    Returns (None, currency) when there is no single honest number: a range like
    'C $10.00 to C $40.00' has no one price, and silently picking an end would
    misreport it in sorting and price-drop detection.
    """
    if not text:
        return None, "CAD"
    text = text.strip()
    currency = "CAD"
    for hint, code in _CURRENCY_HINTS:
        if hint in text:
            currency = code
            break
    if re.search(r"\bto\b", text, re.I):
        return None, currency
    m = _PRICE_RE.search(text)
    if not m:
        return None, currency
    try:
        return float(m.group(1).replace(",", "").replace(" ", "")), currency
    except ValueError:
        return None, currency


def clean(text):
    """Collapse the whitespace that falls out of get_text() on nested markup."""
    return re.sub(r"\s+", " ", text or "").strip()


# ----- signed-in sessions -----

def parse_cookies(raw):
    """Cookies from a browser export, in whichever form you pasted.

    Accepts the two things people actually have to hand:

      * a Cookie header  — ``c_user=100…; xs=abc…; datr=xyz…``
      * a JSON array     — ``[{"name": "c_user", "value": "100…"}, …]``,
        which is what every "export cookies" browser extension produces.

    Returns {name: value}. Never log the result: these *are* the session.
    """
    raw = (raw or "").strip()
    if not raw:
        return {}
    if raw[0] in "[{":
        try:
            data = json.loads(raw)
        except ValueError:
            return {}
        if isinstance(data, dict):                       # {"c_user": "...", ...}
            return {str(k): str(v) for k, v in data.items()}
        out = {}
        for c in data if isinstance(data, list) else []:
            if isinstance(c, dict) and c.get("name"):
                out[str(c["name"])] = str(c.get("value", ""))
        return out
    out = {}
    for part in raw.replace("\n", ";").split(";"):
        if "=" in part:
            name, _, value = part.partition("=")
            name, value = name.strip(), value.strip()
            if name:
                out[name] = value
    return out


def load_cookie_source(env_var):
    """Read cookies from ``$<env_var>`` or, preferred, the file named by
    ``$<env_var>_FILE``.

    The file form exists because putting a session cookie in a compose
    `environment:` block leaks it into `docker inspect`, process listings and
    shell history. A file can be chmod 600 and mounted read-only.
    """
    path = os.environ.get(f"{env_var}_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as fh:
                return parse_cookies(fh.read()), f"{env_var}_FILE"
        except OSError:
            # Deliberately not fatal: a missing cookie file should downgrade to
            # logged-out scraping, not take the whole app down at import time.
            return {}, f"{env_var}_FILE (unreadable)"
    return parse_cookies(os.environ.get(env_var, "")), env_var



class Scraper:
    """Base adapter.

    Subclasses set the class attributes below and implement `search()`. Defining
    a subclass anywhere under `scraper.sites` registers it automatically; set
    `key = ""` on an intermediate base class to keep it out of the registry.
    """

    key = ""            # url-safe id, e.g. "ebay-ca"
    label = ""          # shown in the UI, e.g. "eBay.ca"
    domain = ""         # used for rate limiting
    home_url = ""       # fetched once for cookies, if the site needs it
    currency = "CAD"

    #: Seconds between requests to this site. Raise it for sites that throttle
    #: hard — Facebook starts refusing after a handful of quick hits.
    min_interval = 1.5

    # Feature flags, so the UI can grey out controls a site cannot honour rather
    # than silently ignoring them.
    supports_sort = True
    supports_condition = True
    supports_price_range = True
    supports_categories = False
    #: Whether listings carry a seller name. False disables the per-search
    #: seller blocklist in the UI, rather than letting it be configured and then
    #: silently match nothing (Facebook hides sellers from logged-out requests).
    supports_seller = True
    #: Whether `fetch_detail` is implemented. The item panel shows what the
    #: search already returned either way; this only controls the button that
    #: costs an extra request.
    supports_detail = False

    #: Registry of every concrete adapter, keyed by `key`.
    registry: dict[str, type["Scraper"]] = {}

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        if cls.key:
            Scraper.registry[cls.key] = cls

    #: Env var holding a signed-in session's cookies, if this site can use one.
    #: `<name>_FILE` is read in preference — see `load_cookie_source`.
    cookie_env = ""

    #: Cookies that must all be present for the session to count as signed in.
    #: Checked so a stale or half-copied paste is reported as "not signed in"
    #: rather than silently behaving like a logged-out scrape.
    required_cookies: tuple = ()

    #: How this site is fetched. Override to give a site its own browser
    #: profile, pacing, proxy or warm-up — data, not code. See scraper/http/.
    policy: "FetchPolicy | None" = None

    #: Cookie jars are persisted here between restarts, so a session looks
    #: continuous instead of brand new on every container start.
    cookie_dir = os.environ.get("COOKIE_DIR", "/data/cookies")

    def __init__(self):
        self.cookie_source = ""
        self.authenticated = False
        self.fetcher = self._build_fetcher()
        self._load_session_cookies()

    def _build_fetcher(self):
        """Assemble this site's Fetcher from its policy and class attributes.

        `min_interval`, `home_url` and the block detectors are read off the
        class so an adapter can stay declarative; a policy overrides any of them.
        """
        policy = self.policy or FetchPolicy()
        policy = dataclasses.replace(
            policy,
            min_interval=(policy.min_interval if self.policy
                          else self.min_interval),
            max_interval=(policy.max_interval if self.policy
                          else max(self.min_interval * 3, 5.0)),
            warmup_url=policy.warmup_url or self.home_url,
            cookie_file=policy.cookie_file or os.path.join(
                self.cookie_dir, f"{self.key}.json"),
            detectors=policy.detectors or self.detectors(),
        )
        # User settings overlay the adapter's baseline rather than replacing it:
        # Facebook still needs longer gaps than eBay whatever the preference.
        from .. import settings
        policy = settings.apply_to(policy, domain=self.domain)
        return http.build(self.domain, policy)

    def rebuild_fetcher(self):
        """Re-read settings into a fresh fetcher, so a changed profile or pace
        applies on the next request rather than the next restart.

        Signed-in cookies are re-installed afterwards; dropping them here would
        silently log a Facebook session out on an unrelated settings change.
        """
        old = getattr(self, "fetcher", None)
        self.authenticated = False
        self.cookie_source = ""
        self.fetcher = self._build_fetcher()
        self._load_session_cookies()
        if old is not None:
            try:
                old.close()
            except Exception:                       # noqa: BLE001
                pass

    def detectors(self):
        """(name, fn(text, response) -> message | None) run on every 200.

        The failures that matter arrive as valid responses: eBay's "Pardon Our
        Interruption" and Facebook's logged-out shell are both HTTP 200 pages
        with no data in them.
        """
        return (("interstitial", self._interstitial),)

    #: Phrases that mark a challenge page.
    INTERSTITIAL_MARKERS = (
        "pardon our interruption",
        "checking your browser",
        "enable javascript and cookies to continue",
        "verify you are a human",
        "unusual traffic",
    )

    def _interstitial(self, text, res):
        # Real result pages are large; challenge pages are a few KB. Checking
        # size first keeps this off the hot path for genuine responses.
        if len(text) > 60_000:
            return None
        head = text[:4000].lower()
        if any(m in head for m in self.INTERSTITIAL_MARKERS):
            return (f"{self.label} served a bot check instead of results — "
                    f"usually too many requests too quickly. Waiting a few "
                    f"minutes clears it.")
        return None

    def _load_session_cookies(self):
        """Install signed-in cookies, if any were supplied.

        No password ever reaches this app. Facebook checkpoints scripted logins
        almost immediately and would demand 2FA anyway, so reusing a session you
        established yourself in a browser is both the only thing that works and
        the option that keeps credentials out of here entirely.
        """
        if not self.cookie_env:
            return
        cookies, source = load_cookie_source(self.cookie_env)
        if not cookies:
            return
        missing = [c for c in self.required_cookies if not cookies.get(c)]
        if missing:
            # Names only. The values are the session and must never be logged.
            log.warning("%s: ignoring cookies from %s — missing %s",
                        self.label, source, ", ".join(missing))
            return
        self.fetcher.backend.set_cookies(
            cookies, f".{self.domain.removeprefix('www.')}")
        self.cookie_source = source
        self.authenticated = True
        # A real signed-in session needs no anonymous warm-up.
        self.fetcher._warmed = True
        log.info("%s: using signed-in session from %s (%d cookies)",
                 self.label, source, len(cookies))

    # ---- capabilities ----

    def categories(self) -> list[Category]:
        """Category tree for the UI. Default: none, so a site that has not
        implemented them simply shows no category picker."""
        return []

    def options(self) -> list[Option]:
        """Filters unique to this site. Default: none."""
        return []

    def sorts(self) -> list[Sort]:
        """Orderings this site offers. Override to declare the real list."""
        return [Sort("best", "Best match", "", "best")]

    def sort_by_key(self, key):
        """The declared Sort for `key`, falling back sensibly.

        A saved search may carry a key from another market (its sorts are
        per-site), so fall back to the first sort of the same canonical kind
        before giving up on the default — "cheapest" should stay "cheapest"
        across markets even when the exact option differs.
        """
        available = self.sorts()
        by_key = {s.key: s for s in available}
        if key in by_key:
            return by_key[key]
        wanted_kind = None
        for s in available:
            if s.key == key:
                wanted_kind = s.kind
        # `key` may be a canonical kind rather than a site key.
        for s in available:
            if s.kind == (wanted_kind or key):
                return s
        return available[0]

    def clean_params(self, params):
        """Keep only values this site declared, coerced to their type.

        Anything unrecognised is dropped rather than passed through, so a
        profile edited while pointed at another site cannot smuggle that site's
        filters into this one's URL.
        """
        params = params or {}
        return {o.key: o.coerce(params.get(o.key)) for o in self.options()}

    def describe(self):
        """What /api/sites hands the frontend."""
        return {
            "key": self.key,
            "label": self.label,
            "domain": self.domain,
            "currency": self.currency,
            "authenticated": self.authenticated,
            "supports": {
                "sort": self.supports_sort,
                "condition": self.supports_condition,
                "price_range": self.supports_price_range,
                "categories": self.supports_categories,
                "seller": self.supports_seller,
                "detail": self.supports_detail,
            },
            "categories": [asdict(c) for c in self.categories()],
            "options": [o.as_dict() for o in self.options()],
            "sorts": [s.as_dict() for s in self.sorts()],
        }

    # ---- fetching ----

    def get(self, url, referer=None, **kw):
        """A browser-shaped GET: impersonated TLS/HTTP2, realistic headers,
        jittered pacing, persisted cookies, warm-up and retries.

        All of that lives in scraper/http/ so adapters describe sites rather
        than repeating evasion logic — and so improving realism improves every
        site at once. Failures are re-raised as ScrapeError, which is what the
        API already knows how to shape for the UI.
        """
        try:
            return self.fetcher.get(url, referer=referer, **kw)
        except http.BlockedError as e:
            raise ScrapeError(str(e)) from e
        except http.FetchError as e:
            raise ScrapeError(str(e)) from e

    def describe_fetcher(self):
        """What this site's transport is actually doing — surfaced by
        /api/health so "am I still fingerprintable as Python?" is answerable."""
        return self.fetcher.describe()

    # ---- the one thing every adapter must implement ----

    def search(self, opts: SearchOptions) -> list[Listing]:
        raise NotImplementedError

    def fetch_detail(self, url) -> dict:
        """Extra fields from one listing's own page — description above all.

        Optional: search results are enough to browse, and this costs a request
        per item. Return whatever the site gives; the panel renders what it
        receives and skips what is missing.
        """
        raise NotImplementedError
