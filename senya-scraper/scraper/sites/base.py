"""
Base class every marketplace adapter builds on, plus the bits they all share.

An adapter should read as a description of one site: which URL its search lives
at, and how to pull fields out of its HTML. Politeness, session priming, retries,
error shaping and price parsing are all here so they cannot drift between sites.

Subclasses register themselves just by existing — see `__init_subclass__` — so
adding a site is one new file in this package and no edit anywhere else.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import asdict, dataclass, field

import requests

# A real browser string. Not an attempt to hide what we are: several of these
# sites return 403 to anything that looks scripted, and the alternative is an app
# that cannot fetch its own data.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-CA,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}


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
    seller: str = ""
    image: str = ""
    posted_at: str = ""                 # site's own timestamp, when it gives one
    extra: dict = field(default_factory=dict)

    def as_dict(self):
        return asdict(self)


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
        return cls(
            query=(src.get("query") or "").strip(),
            sort=src.get("sort") or "best",
            condition=src.get("condition") or "any",
            category=src.get("category") or "",
            min_price=num("min_price"),
            max_price=num("max_price"),
            page=int(src.get("page") or 1),
        )


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


# ----- politeness -----

class RateLimiter:
    """A floor on the gap between requests to the same domain.

    Global and blocking rather than per-session: two browser tabs searching at
    once should still add up to a civil request rate, and a homelab app has no
    reason to be fast enough to get itself blocked.
    """

    def __init__(self, min_interval=1.5):
        self.min_interval = min_interval
        self._last = {}
        self._locks = {}
        self._guard = threading.Lock()

    def _lock_for(self, domain):
        with self._guard:
            return self._locks.setdefault(domain, threading.Lock())

    def wait(self, domain):
        with self._lock_for(domain):
            gap = time.monotonic() - self._last.get(domain, 0.0)
            if gap < self.min_interval:
                time.sleep(self.min_interval - gap)
            self._last[domain] = time.monotonic()


LIMITER = RateLimiter()


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

    # Feature flags, so the UI can grey out controls a site cannot honour rather
    # than silently ignoring them.
    supports_sort = True
    supports_condition = True
    supports_price_range = True
    supports_categories = False

    #: Registry of every concrete adapter, keyed by `key`.
    registry: dict[str, type["Scraper"]] = {}

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        if cls.key:
            Scraper.registry[cls.key] = cls

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self._primed = False

    # ---- capabilities ----

    def categories(self) -> list[Category]:
        """Category tree for the UI. Default: none, so a site that has not
        implemented them simply shows no category picker."""
        return []

    def describe(self):
        """What /api/sites hands the frontend."""
        return {
            "key": self.key,
            "label": self.label,
            "domain": self.domain,
            "currency": self.currency,
            "supports": {
                "sort": self.supports_sort,
                "condition": self.supports_condition,
                "price_range": self.supports_price_range,
                "categories": self.supports_categories,
            },
            "categories": [asdict(c) for c in self.categories()],
        }

    # ---- fetching ----

    def prime(self):
        """Some sites 403 a cold hit on their search endpoint but hand out a
        session on the homepage first (eBay does exactly this). Best-effort: if
        it fails, the search still runs and produces the more useful error."""
        if self._primed or not self.home_url:
            return
        try:
            LIMITER.wait(self.domain)
            self.session.get(self.home_url, timeout=15)
        except requests.RequestException:
            pass
        self._primed = True

    def get(self, url, **kw):
        """Rate-limited GET that turns transport failures into ScrapeError."""
        self.prime()
        LIMITER.wait(self.domain)
        kw.setdefault("timeout", 25)
        try:
            res = self.session.get(url, **kw)
        except requests.Timeout:
            raise ScrapeError(f"{self.label} timed out. It may be slow or blocking us.")
        except requests.RequestException as e:
            raise ScrapeError(f"Could not reach {self.label}: {e}")
        if res.status_code == 403:
            # The failure mode that actually happens. Drop the primed flag so the
            # next attempt re-establishes a session, which often clears it.
            self._primed = False
            raise ScrapeError(
                f"{self.label} refused the request (403) — its bot protection "
                f"tripped. Trying again in a minute usually works."
            )
        if res.status_code != 200:
            raise ScrapeError(f"{self.label} returned HTTP {res.status_code}.")
        return res

    # ---- the one thing every adapter must implement ----

    def search(self, opts: SearchOptions) -> list[Listing]:
        raise NotImplementedError
