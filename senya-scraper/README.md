# SenyaScraper

Marketplace product search for the homelab. Searches second-hand sites from one
box and, for searches you **save**, tells you what changed since last time:
which listings are **new** and which **dropped in price**.

That diff is the point. Running the same eBay search by hand every day and
trying to spot what moved is exactly the job a computer should do.

**eBay.ca** is implemented. The structure assumes more will follow (Kijiji,
AutoTrader, …) — see [Adding a marketplace](#adding-a-marketplace).

## Run

```bash
docker compose up --build -d senya-scraper   # → http://localhost:8005
```

## Layout

Every layer is extended by **adding a file**, not by editing a hub:

```
app.py                    WSGI entrypoint (gunicorn app:app) — nothing but create_app()
scraper/
  __init__.py             app factory: config, db, blueprints, notifiers
  db.py                   SQLite connection + append-only migrations
  events.py               tiny event bus decoupling "it happened" from "who cares"
  api/
    __init__.py           blueprint list — one line per endpoint group
    sites.py              GET /api/sites, /api/health
    search.py             POST /api/search          (live, persists nothing)
    searches.py           saved searches + the new/price-drop diff
  sites/
    __init__.py           auto-discovering registry (imports every sibling)
    base.py               Scraper, Listing, SearchOptions, Category, rate limiter
    ebay_ca.py            eBay.ca adapter
  notify/
    __init__.py           auto-discovering channel registry
    base.py               Channel: what to listen to, how to format
    log.py                default channel — writes to the container log
static/                   vanilla-JS frontend (no build step)
```

### Adding a marketplace

One file. `Scraper` subclasses register themselves by existing, so nothing else
changes — the API and the site picker both build from the registry.

```python
# scraper/sites/kijiji.py
from .base import Listing, Scraper, SearchOptions, clean, parse_price

class Kijiji(Scraper):
    key, label, domain = "kijiji", "Kijiji", "www.kijiji.ca"
    home_url = "https://www.kijiji.ca/"
    supports_categories = True

    def search(self, opts: SearchOptions) -> list[Listing]:
        res = self.get(...)           # rate-limited, session-primed, error-shaped
        return [...]
```

Declare what the site can actually filter by (`supports_sort`,
`supports_price_range`, …) and the UI greys out the controls it cannot honour
instead of silently ignoring them.

### Per-site search options

Every marketplace has a query, a sort and a price range, so those are shared
fields on `SearchOptions`. Everything a site can filter by that others **cannot**
— eBay's buying format, a car site's mileage — is declared by the adapter as an
`Option`, and the frontend renders the controls from that description:

```python
OPTIONS = [
    Option("buying_format", "Buying format", "choice",
           choices=(("any", "Any"), ("bin", "Buy It Now"), ("auction", "Auction")),
           default="any"),
    Option("free_shipping", "Free shipping only", "bool", default=False),
]
```

Types are `bool · choice · text · number`. Adding a filter is one line in one
adapter: no frontend change, no shared field that other sites have to ignore,
and no site's filters leaking into another's URL — `clean_params()` keeps only
the keys that site declared and coerces them to their type.

Values are stored per site, as JSON keyed by site key:

```json
{"ebay-ca": {"buying_format": "bin", "free_shipping": true},
 "kijiji":  {"radius_km": 25}}
```

So a saved profile pointed at eBay keeps its Kijiji settings if you switch it
over and back, and each site is configured completely independently.

### Adding a notification channel

Same shape. Configured channels are wired to the event bus at startup; an
unconfigured one is skipped, so an unset env var means silence, not an error.

```python
# scraper/notify/ntfy.py
import os, requests
from .base import Channel

class Ntfy(Channel):
    key, label = "ntfy", "ntfy.sh"
    def configured(self):
        return bool(os.environ.get("NTFY_URL"))
    def send(self, title, body, links):
        requests.post(os.environ["NTFY_URL"], data=body.encode("utf-8"),
                      headers={"Title": title}, timeout=10)
```

Events currently emitted (see `scraper/events.py`):

| Event | Payload |
|---|---|
| `listings.new` | items never seen before for that saved search |
| `listings.price_drop` | items whose price fell since the last run, with `was` |

### Adding an endpoint group / schema change

A new module in `scraper/api/` plus one entry in its `MODULES` tuple. For
storage, **append** a string to `db.MIGRATIONS` — never edit a shipped one;
`PRAGMA user_version` upgrades existing databases on next start.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/sites` | sites, their `supports` flags and category lists |
| `GET` | `/api/health` | registered sites + notification channels |
| `POST` | `/api/search` | live search, persists nothing |
| `GET`/`POST` | `/api/searches` | list / create saved searches |
| `GET`/`PATCH` | `/api/searches/<id>` | read / edit one profile (partial payload) |
| `DELETE` | `/api/searches/<id>` | |
| `POST` | `/api/searches/<id>/run` | re-run + diff → `{new, price_drops, results}` |
| `GET` | `/api/searches/<id>/results` | stored listings (`?include_gone=1`) |

Search body: `{query, site, category, sort, condition, min_price, max_price, params}`.
`sort` is one of `best · newest · price-asc · price-desc`; `params` holds that
site's own options (see above).

Editing a profile keeps its stored listings on purpose — tightening a price
ceiling should not make everything already seen look new on the next run. Items
that fall outside the new criteria just stop coming back and get flagged `gone`.

**Status codes matter here.** `400` is your mistake (no query, unknown site);
`502` means the marketplace refused or changed shape — a real thing that
happens, not a bug in this service, and the message says what to do about it.

## Notes on scraping eBay

Three behaviours cost real debugging time, so they are documented in
`scraper/sites/ebay_ca.py` rather than rediscovered:

- **A cold request to `/sch/` returns 403.** Fetching the homepage first and
  reusing those cookies works; that is what `home_url` / `Scraper.prime()` do.
- **Rate limiting arrives as HTTP 200.** Push too hard and eBay serves a
  *"Pardon Our Interruption — checking your browser"* interstitial with a
  success status, which parses as a valid page with zero results. `Scraper`
  sniffs for it (`INTERSTITIAL_MARKERS`) and says "you are being rate limited"
  rather than the very misleading "their markup changed".
- **Results use `.s-card`, not `.s-item`.** eBay changed the markup — older
  selectors match nothing and look like "no results".
- **Every card's footer reads `derosnopS`** — "Sponsored" reversed, to defeat
  scrapers. It appears on organic listings too, so it is not a usable flag.

eBay also pads results with placeholder *"Shop on eBay"* cards pointing at
`/itm/123456`, and hides *"Opens in a new window or tab"* inside every title for
screen readers. Both are stripped.

Requests are rate limited per domain (`RateLimiter`, 1.5 s floor, global across
threads) so two open tabs still add up to a civil request rate.

### Which sites will actually work

- **eBay.ca** — works, with the session priming above.
- **Kijiji / AutoTrader** — reachable from this host; adapters not yet written.
- **Facebook Marketplace** — realistically out of reach. It requires a logged-in
  session, renders results from JavaScript rather than HTML, and its terms
  prohibit automated collection. An adapter would need a real browser and a real
  account, and would break constantly. Worth knowing before it goes on a roadmap.

Sites change their markup without warning; an adapter that suddenly returns
nothing usually means selectors, not a crash. `search()` raises a distinct error
for "page loaded but nothing recognisable" precisely so that case is not
mistaken for "no matches".
