"""
Facebook Marketplace.

Read this before assuming the adapter is broken — Facebook behaves unlike the
other sites in three ways that all look like bugs:

  1. **The results are not in the HTML.** Marketplace renders from JavaScript, so
     there is nothing to select. The listings *are* present, embedded in a Relay
     payload inside `<script type="application/json">`, which is what this
     adapter walks. Selector-based scraping of this site cannot work.
  2. **A cold request returns HTTP 400**, homepage included. Priming cookies from
     facebook.com first turns the search into a 200 — same trick as eBay, but
     Facebook is stricter about it and the session goes stale quickly.
  3. **Success is not guaranteed even at 200.** Facebook frequently serves a
     logged-out shell: a large, valid page with the right title and no embedded
     listings at all. That is throttling, not an empty result set, and the two
     are reported differently below.

Consequently this adapter is best-effort. It works, but expect it to fail more
often than eBay, and expect it to break when Facebook renames a GraphQL field.

**No seller information.** `marketplace_listing_seller` is null when logged out,
so `Listing.seller_name` is empty and the per-search seller blocklist cannot
match anything here. `supports_seller` is False so the UI can say so rather than
letting you configure something that silently does nothing.

Scope: one page of results (Facebook returns ~12 and paginates over GraphQL with
signed tokens, which is out of reach without a session).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from urllib.parse import urlencode

from bs4 import BeautifulSoup

from .base import Listing, Option, Scraper, ScrapeError, SearchOptions, parse_price

# The field that marks a node as a listing. Everything else is read relative to
# it, so if Facebook renames this one key the adapter fails loudly rather than
# returning half-populated rows.
TITLE_KEY = "marketplace_listing_title"


class FacebookMarketplace(Scraper):
    key = "facebook"
    label = "FB Marketplace"
    domain = "www.facebook.com"
    home_url = "https://www.facebook.com/"
    # Facebook throttles far more aggressively than the others; a handful of
    # quick requests is enough to start getting 400s on every URL.
    min_interval = 6.0

    supports_categories = False
    supports_condition = False   # logged-out search exposes no condition filter
    supports_seller = False      # seller is null without a session — see above

    SORTS = {
        "best": None,                       # Facebook's default relevance
        "newest": "creation_time_descend",
        "price-asc": "price_ascend",
        "price-desc": "price_descend",
    }

    # Marketplace is scoped to a city in the URL path, with no national search —
    # so unlike every other site here, location is not optional. A site-specific
    # Option is exactly the right place for that.
    OPTIONS = [
        Option("location", "City", "text", default="toronto",
               help="Facebook scopes Marketplace by city; use the slug from the "
                    "URL, e.g. toronto, calgary, nyc."),
        Option("radius_km", "Radius (km)", "number", default=None,
               help="Blank for Facebook's default."),
        Option("days_listed", "Listed within (days)", "choice",
               choices=(("", "Any time"), ("1", "Last 24 hours"),
                        ("7", "Last week"), ("30", "Last month")),
               default=""),
    ]

    def options(self):
        return self.OPTIONS

    # ----- request -----

    def build_url(self, opts: SearchOptions):
        p = self.clean_params(opts.params)
        city = (p.get("location") or "toronto").strip().strip("/") or "toronto"

        params = {"query": opts.query}
        sort = self.SORTS.get(opts.sort)
        if sort:
            params["sortBy"] = sort
        if opts.min_price is not None:
            params["minPrice"] = int(opts.min_price)
        if opts.max_price is not None:
            params["maxPrice"] = int(opts.max_price)
        if p.get("radius_km"):
            params["radius"] = int(p["radius_km"])
        if p.get("days_listed"):
            params["daysSinceListed"] = p["days_listed"]
        return f"https://www.facebook.com/marketplace/{city}/search?" + urlencode(params)

    def search(self, opts: SearchOptions):
        if not opts.query:
            raise ScrapeError("Enter something to search for.")
        res = self.get(self.build_url(opts))
        nodes = self._extract(res.text)
        if not nodes:
            # The shell is a big, valid page — so "no nodes" almost always means
            # throttled, not empty. Saying "no results" here would send you
            # hunting for a better query when the fix is to wait.
            raise ScrapeError(
                "Facebook returned a page with no listing data. It serves a "
                "logged-out shell when it is throttling — waiting a few minutes "
                "usually helps. If it persists, they may have changed the "
                "payload; see scraper/sites/facebook.py."
            )
        out, seen = [], set()
        for node in nodes:
            item = self._to_listing(node)
            if item and item.uid not in seen:
                seen.add(item.uid)
                out.append(item)
        return out

    # ----- payload -----

    @staticmethod
    def _extract(html):
        """Every listing node in the page's embedded JSON.

        Walks the whole tree rather than following a fixed path: Facebook nests
        these under query-specific keys that change between page variants, and a
        hard-coded path breaks far more often than a search for the one field
        that identifies a listing.
        """
        soup = BeautifulSoup(html, "lxml")
        hits = []

        def walk(node):
            if isinstance(node, dict):
                if TITLE_KEY in node:
                    hits.append(node)
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        for script in soup.find_all("script", type="application/json"):
            raw = script.string
            if not raw or TITLE_KEY not in raw:
                continue                      # cheap reject before parsing
            try:
                walk(json.loads(raw))
            except (ValueError, RecursionError):
                continue
        return hits

    def _to_listing(self, node):
        title = (node.get(TITLE_KEY) or "").strip()
        listing_id = node.get("id")
        if not title or not listing_id:
            return None
        # Sold items linger in the payload; they are noise in a "what can I buy"
        # list and would also churn the new/price-drop diff.
        if node.get("is_sold") or node.get("is_hidden") or node.get("is_pending"):
            return None

        price_text, price, currency = "", None, self.currency
        lp = node.get("listing_price") or {}
        if lp:
            price_text = lp.get("formatted_amount") or ""
            # `amount` is the clean decimal string; prefer it over re-parsing
            # "CA$150", and fall back to the shared parser if it is missing.
            try:
                price = float(lp["amount"])
            except (KeyError, TypeError, ValueError):
                price, currency = parse_price(price_text)
            else:
                _, currency = parse_price(price_text)

        was = (node.get("strikethrough_price") or {}).get("formatted_amount") or ""

        loc = ((node.get("location") or {}).get("reverse_geocode") or {})
        city, state = loc.get("city") or "", loc.get("state") or ""
        location = ", ".join(x for x in (city, state) if x)

        image = (((node.get("primary_listing_photo") or {})
                  .get("image") or {}).get("uri") or "")

        posted = ""
        if node.get("creation_time"):
            try:
                posted = datetime.fromtimestamp(
                    int(node["creation_time"]), timezone.utc).strftime("%Y-%m-%d")
            except (TypeError, ValueError, OSError):
                posted = ""

        return Listing(
            uid=f"{self.key}:{listing_id}",
            site=self.key,
            title=title,
            url=f"https://www.facebook.com/marketplace/item/{listing_id}/",
            price=price,
            currency=currency,
            price_text=price_text,
            location=location,
            image=image,
            posted_at=posted,
            # seller stays empty: null when logged out, hence supports_seller.
            extra={"listing_id": str(listing_id),
                   "was_price": was,
                   "city": city},
        )
