"""
eBay.ca search results.

Two things about eBay's markup are worth knowing before touching the selectors,
because both look like bugs otherwise:

  1. Results use `.s-card`, not the `.s-item` that older examples describe —
     eBay changed the markup, and the old selectors silently match nothing.
  2. Every card carries a footer reading "derosnopS": "Sponsored" reversed, a
     scraper-defeating trick. It appears on organic listings too, so it is NOT a
     usable sponsored flag and we ignore it.

eBay also pads results with placeholder "Shop on eBay" cards pointing at
/itm/123456 for $20.00. Those are filler, not listings, and are dropped.

Reaching search at all needs a session cookie first: a cold request to /sch/
returns 403, but fetching the homepage once and reusing the cookies works. That
is what `home_url` and `Scraper.prime()` are for.
"""

from __future__ import annotations

import re
from urllib.parse import urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from ..http import FetchPolicy
from .base import (Category, Listing, Option, Scraper, ScrapeError, SearchOptions,
                   Sort, clean, parse_price)

# The numeric id in /itm/<id> — stable per item, unlike the full URL, which
# carries per-search tracking params that change every run.
_ITEM_ID_RE = re.compile(r"/itm/(\d+)")

# Condition strings eBay puts in the subtitle row.
_CONDITIONS = {
    "brand new", "new (other)", "new with tags", "new without tags",
    "pre-owned", "open box", "certified - refurbished", "excellent - refurbished",
    "very good - refurbished", "good - refurbished", "seller refurbished",
    "for parts or not working", "used",
}


class EbayCA(Scraper):
    key = "ebay-ca"
    label = "eBay.ca"
    domain = "www.ebay.ca"
    home_url = "https://www.ebay.ca/"
    supports_categories = True
    supports_detail = True

    # A cold hit on /sch/ is refused; landing on the homepage first earns a
    # session, and the Referer on the search is then genuine. Pacing is jittered
    # rather than a fixed floor — clicking at exactly 1.5s intervals is itself a
    # signature.
    policy = FetchPolicy(profile="chrome-mac", min_interval=1.5, max_interval=6.0,
                         warmup_url="https://www.ebay.ca/")

    # eBay's _sop codes. It distinguishes item price from price+shipping, which
    # matters: sorting by price alone puts a $9 item with $118 shipping above a
    # $60 item posted free. Verified against live results — _sop=2 orders by item
    # price with erratic shipping, _sop=15 by the total.
    SORTS = [
        Sort("best", "Best match", "12", "best"),
        Sort("price-ship-asc", "Cheapest + shipping", "15", "price-asc"),
        Sort("price-asc", "Cheapest (item only)", "2", "price-asc"),
        Sort("price-ship-desc", "Dearest + shipping", "16", "price-desc"),
        Sort("price-desc", "Dearest (item only)", "3", "price-desc"),
        Sort("newest", "Newly listed", "10", "newest"),
        Sort("ending", "Ending soonest", "1", "ending"),
    ]
    CONDITIONS = {"any": None, "new": "1000", "used": "3000"}

    # A starter set of eBay's top-level category ids (_sacat). Extend freely —
    # the UI renders whatever this returns.
    CATEGORIES = [
        Category("all", "All categories", ""),
        Category("electronics", "Consumer electronics", "293"),
        Category("computers", "Computers/tablets", "58058"),
        Category("cell-phones", "Cell phones & accessories", "15032"),
        Category("cameras", "Cameras & photo", "625"),
        Category("home-garden", "Home & garden", "11700"),
        Category("clothing", "Clothing & accessories", "11450"),
        Category("sporting", "Sporting goods", "888"),
        Category("toys", "Toys & hobbies", "220"),
        Category("motors", "eBay Motors", "6000"),
        Category("music", "Musical instruments", "619"),
        Category("collectibles", "Collectibles", "1"),
    ]

    # eBay's own filters, which most other marketplaces have no equivalent for.
    # Declared rather than hard-coded into the URL builder so the UI can render
    # them without knowing anything about eBay, and so a site that lacks them
    # simply has none to render. Each maps to one of eBay's LH_* query params.
    OPTIONS = [
        Option("buying_format", "Buying format", "choice",
               choices=(("any", "Any"), ("bin", "Buy It Now"),
                        ("auction", "Auction"), ("offer", "Best Offer")),
               default="any"),
        Option("item_location", "Item location", "choice",
               choices=(("any", "Anywhere"), ("ca", "Canada only"),
                        ("na", "North America")),
               default="any",
               help="Cuts out long international shipping."),
        Option("free_shipping", "Free shipping only", "bool", default=False),
        Option("returns", "Returns accepted", "bool", default=False),
        Option("sold", "Sold & completed listings", "bool", default=False,
               help="Shows what things actually sold for, not what sellers ask."),
    ]

    # option value -> the LH_* params eBay wants for it
    _FORMAT_PARAMS = {"bin": {"LH_BIN": "1"},
                      "auction": {"LH_Auction": "1"},
                      "offer": {"LH_BO": "1"}}
    _LOCATION_PARAMS = {"ca": {"LH_PrefLoc": "1"}, "na": {"LH_PrefLoc": "2"}}

    def categories(self):
        return self.CATEGORIES

    def options(self):
        return self.OPTIONS

    def sorts(self):
        return self.SORTS

    # ----- request -----

    def build_url(self, opts: SearchOptions):
        params = {
            "_nkw": opts.query,
            "_ipg": "60",     # 60/page; eBay allows 240 but big pages draw attention
            "_sop": self.sort_by_key(opts.sort).value,
        }
        if opts.page > 1:
            params["_pgn"] = str(opts.page)
        cond = self.CONDITIONS.get(opts.condition)
        if cond:
            params["LH_ItemCondition"] = cond
        cat = self._category_value(opts.category)
        if cat:
            params["_sacat"] = cat
        # Send these only when set: empty values return zero results.
        if opts.min_price is not None:
            params["_udlo"] = str(opts.min_price)
        if opts.max_price is not None:
            params["_udhi"] = str(opts.max_price)
        params.update(self._option_params(opts))
        return "https://www.ebay.ca/sch/i.html?" + urlencode(params)

    def _option_params(self, opts):
        """Translate this site's declared options into eBay's LH_* params.

        `clean_params` has already dropped anything not declared here, so an
        unexpected key cannot reach the URL.
        """
        p = self.clean_params(opts.params)
        out = {}
        out.update(self._FORMAT_PARAMS.get(p.get("buying_format"), {}))
        out.update(self._LOCATION_PARAMS.get(p.get("item_location"), {}))
        if p.get("free_shipping"):
            out["LH_FS"] = "1"
        if p.get("returns"):
            out["LH_RPA"] = "1"
        if p.get("sold"):
            # eBay wants both: Sold alone still shows unsold completed items.
            out["LH_Sold"] = "1"
            out["LH_Complete"] = "1"
        return out

    def _category_value(self, key):
        if not key or key == "all":
            return ""
        for c in self.CATEGORIES:
            if c.key == key:
                return c.value
        # An unknown key is a caller bug, but dropping the filter quietly would
        # return the whole site's results and look like the filter "did nothing".
        raise ScrapeError(f"Unknown eBay category '{key}'.")

    # ----- parse -----

    def search(self, opts: SearchOptions):
        if not opts.query:
            raise ScrapeError("Enter something to search for.")
        res = self.get(self.build_url(opts))
        soup = BeautifulSoup(res.text, "lxml")
        cards = soup.select("li.s-card, div.s-card")
        if not cards:
            # Distinguish "no matches" from "our selectors are stale": the second
            # needs a code change and should not look like an empty shelf.
            if soup.select_one(".srp-save-null-search__heading, .s-answer-region"):
                return []
            raise ScrapeError(
                "eBay returned a page with no recognisable listings. Their markup "
                "may have changed — see scraper/sites/ebay_ca.py."
            )
        out, seen = [], set()
        for card in cards:
            item = self._parse_card(card)
            if item and item.uid not in seen:
                seen.add(item.uid)
                out.append(item)
        return out

    def _parse_card(self, card):
        a = card.select_one("a.s-card__link[href]") or card.select_one("a[href]")
        title_el = card.select_one(".s-card__title")
        if not a or not title_el:
            return None

        # eBay hides "Opens in a new window or tab" inside the title for screen
        # readers. get_text() has no idea it is invisible, so it lands in every
        # title (and every notification) unless it is removed first.
        for hidden in title_el.select(".clipped"):
            hidden.decompose()
        title = clean(title_el.get_text(" "))
        href = a["href"]
        m = _ITEM_ID_RE.search(href)
        # Placeholder filler: the fake id, and the title eBay uses for it.
        if not m or m.group(1) == "123456" or title.lower() == "shop on ebay":
            return None
        item_id = m.group(1)

        price_el = card.select_one(".s-card__price")
        price_text = clean(price_el.get_text(" ")) if price_el else ""
        price, currency = parse_price(price_text)

        rows = [clean(r.get_text(" ")) for r in card.select(".s-card__attribute-row")]
        shipping = next((r for r in rows if "shipping" in r.lower()
                         or "livraison" in r.lower()), "")
        seller = next((r for r in rows if "% positive" in r), "")
        # "acme-parts 99.2% positive (431)" -> "acme-parts". eBay usernames never
        # contain spaces, so the first token is the account.
        seller_name = seller.split(" ", 1)[0] if seller else ""

        sub = card.select_one(".s-card__subtitle")
        condition = clean(sub.get_text(" ")) if sub else ""
        if condition and condition.lower() not in _CONDITIONS and len(condition) >= 30:
            # The subtitle slot is reused for marketing blurbs; keep it only when
            # it plausibly is a condition, so the UI chip stays meaningful.
            condition = ""

        img = card.select_one("img")
        image = ""
        if img:
            image = img.get("src") or img.get("data-src") or ""
            # Cards ship a 500px thumb; the 225 variant is a quarter of the bytes
            # and still sharp at the size the grid renders it.
            image = re.sub(r"/s-l\d+\.(webp|jpg|png)", r"/s-l225.\1", image)

        return Listing(
            uid=f"{self.key}:{item_id}",
            site=self.key,
            title=title,
            url=self._clean_url(href),
            price=price,
            currency=currency,
            price_text=price_text,
            condition=condition,
            shipping=shipping,
            seller=seller,
            seller_name=seller_name,
            image=image,
            extra={"item_id": item_id,
                   "best_offer": any("best offer" in r.lower() for r in rows)},
        )

    @staticmethod
    def _clean_url(href):
        """Drop eBay's tracking query string: it is long, changes every search,
        and the bare /itm/<id> URL resolves fine."""
        p = urlsplit(href)
        return urlunsplit((p.scheme, p.netloc, p.path, "", ""))

    # ----- detail -----

    def fetch_detail(self, url):
        """Description, full photo set and item specifics from an /itm/ page.

        eBay puts the seller's description in a same-origin iframe rather than
        the page body, so it is fetched separately — reading the placeholder
        div returns an empty shell.
        """
        soup = BeautifulSoup(self.get(url).text, "lxml")
        out = {"url": url}

        subtitle = soup.select_one(".x-item-title__subtitle, .x-item-title-subtitle")
        if subtitle:
            out["subtitle"] = clean(subtitle.get_text(" "))

        # Item specifics. eBay has shipped several markups for this grid and
        # serves different ones to different sessions, so try each known shape
        # and take the first that yields anything. A missing spec block is not
        # worth failing over — the description is the part that matters.
        specs = {}
        for label_sel, value_sel in (
            (".ux-labels-values__labels", ".ux-labels-values__values"),
            ("dt", "dd"),
        ):
            for row in soup.select(".ux-layout-section--features .ux-labels-values, "
                                   ".ux-layout-section-evo dl, dl.ux-labels-values"):
                label = row.select_one(label_sel)
                value = row.select_one(value_sel)
                if not (label and value):
                    continue
                k = clean(label.get_text(" ")).rstrip(":")
                v = clean(value.get_text(" "))
                if k and v and len(k) < 40 and len(specs) < 24:
                    specs.setdefault(k, v)
            if specs:
                break
        if specs:
            out["specs"] = specs

        photos = []
        for img in soup.select("img[data-zoom-src], .ux-image-carousel-item img"):
            src = img.get("data-zoom-src") or img.get("src") or ""
            if src.startswith("http") and src not in photos:
                photos.append(re.sub(r"/s-l\d+\.", "/s-l800.", src))
        if photos:
            out["photos"] = photos[:12]

        frame = soup.select_one("iframe#desc_ifr, iframe[title*='escription']")
        if frame and frame.get("src"):
            try:
                desc = BeautifulSoup(self.get(frame["src"], referer=url).text, "lxml")
                for junk in desc(["script", "style"]):
                    junk.decompose()
                text = clean(desc.get_text(" "))
                if text:
                    out["description"] = text[:4000]
            except ScrapeError:
                # A missing description is not worth failing the whole panel.
                pass
        return out
