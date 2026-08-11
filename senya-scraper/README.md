# SenyaScraper

Marketplace product search for the homelab. Searches second-hand sites from one
box and, for searches you **save**, tells you what changed since last time:
which listings are **new** and which **dropped in price**.

That diff is the point. Running the same eBay search by hand every day and
trying to spot what moved is exactly the job a computer should do.

**eBay.ca** and **Facebook Marketplace** are implemented. The structure assumes
more will follow (Kijiji, AutoTrader, …) — see
[Adding a marketplace](#adding-a-marketplace).

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

### Blocked sellers

Each saved search keeps its own blocklist of seller accounts — per search, not
global, because a seller who floods one query with junk may be exactly who you
want for another. Set it in the edit dialog (one per line or comma-separated),
or click the **⊘** next to a seller on any result card.

Filtering happens locally rather than by asking the marketplace to exclude them:
not every site supports it, and doing it here means one behaviour everywhere. A
run reports how many it hid (`hidden` in the response) so results never just
silently come up short. Blocked listings are dropped *before* anything is
stored, so unblocking someone later does not announce their whole back catalogue
as new.

### Searching every market at once

Pass `"sites": "all"` (or a list) instead of a single `site`, in a live search or
on a saved profile. Each market keeps its own per-site options, so one profile
can be Buy-It-Now-only on eBay *and* within 25 km of Calgary on Facebook.

**A combined search is never all-or-nothing.** These sites throttle
independently, so one being blocked while the others answer is the normal case.
The response carries whatever came back plus a per-site `errors` list, and the
UI shows which markets are missing — failing everything because Facebook is
sulking would make the feature useless. Only when *every* site fails does it
become a 502.

Sites are queried in parallel. The rate limiter is per-domain, so hitting two
marketplaces at once is no less polite to either, and serialising them would
make a combined search as slow as the sum of its parts (Facebook alone holds a
6 s floor).

**Rankings do not merge**, so the strategy depends on the sort:

| Sort | Strategy |
|---|---|
| `price-asc` / `price-desc` | A real shared scale — sorted across everything. Listings with no single price (auction ranges, "contact seller") sort last in **both** directions rather than pretending to be free. |
| `newest` | Only meaningful where the site gives a date, and eBay gives none. Dated listings lead in order; undated ones follow, interleaved. |
| `best` | No cross-site meaning at all. Round-robin, so the top of the page holds each site's own best few rather than one market burying the other. |

On a saved search, a market that **errored** is skipped when flagging listings
`gone`: they are absent because we could not ask, not because they sold. Without
that, one throttled run would mark a whole market's history as vanished and then
re-announce all of it as new.

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
| `POST` | `/api/search` | live search, persists nothing; `sites` may be a list or `"all"` |
| `GET`/`POST` | `/api/searches` | list / create saved searches |
| `GET`/`PATCH` | `/api/searches/<id>` | read / edit one profile (partial payload) |
| `DELETE` | `/api/searches/<id>` | |
| `POST` | `/api/searches/<id>/run` | re-run + diff → `{new, price_drops, hidden, results}` |
| `POST` | `/api/searches/<id>/block` | `{seller}` to hide, `{seller, unblock: true}` to restore |
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
- **Facebook Marketplace** — works, but is the least reliable of the two; see
  below.
- **Kijiji / AutoTrader** — reachable from this host; adapters not yet written.

Sites change their markup without warning; an adapter that suddenly returns
nothing usually means selectors, not a crash. `search()` raises a distinct error
for "page loaded but nothing recognisable" precisely so that case is not
mistaken for "no matches".

## Notes on scraping Facebook Marketplace

Facebook works, but not the way the other adapters do, and each difference looks
like a bug if you do not know about it:

- **The listings are not in the HTML.** Marketplace renders from JavaScript, so
  there is nothing to select — CSS-selector scraping of this site cannot work at
  all. The data *is* there, embedded in a Relay payload inside
  `<script type="application/json">`, and `_extract()` walks the JSON for nodes
  carrying `marketplace_listing_title`. It searches the whole tree rather than
  following a fixed path, because Facebook nests these under keys that vary
  between page variants.
- **Cold requests return HTTP 400** — even the homepage. Priming cookies first
  turns the search into a 200, but the session goes stale much faster than
  eBay's.
- **A 200 does not mean results.** When throttling, Facebook serves a large,
  valid logged-out shell with no listings in it. That is reported as "no listing
  data, wait a few minutes" rather than "no matches", because they need
  completely different responses from you.
- **`min_interval` is 6 s here**, against 1.5 s elsewhere. A handful of quick
  requests is enough to start getting 400s on every URL for a while.

**No seller data when logged out.** `marketplace_listing_seller` is null for
anonymous requests, so the per-search seller blocklist has nothing to match on.
`supports_seller` follows the session state and the UI hides the field, rather
than letting you configure something that would silently do nothing. Sign in
(below) and both come back.

### Using a signed-in Facebook account

Signing in gets you seller names (so the blocklist works) and generally more
results. SenyaScraper reuses a session **you** established in a browser.

> **It never handles your password, and that is deliberate.** Facebook
> checkpoints scripted logins almost immediately and would demand 2FA anyway, so
> automating the login form would not work *and* would mean storing credentials.
> Reusing a browser session is the only approach that works and the one that
> keeps your password out of this app entirely.

1. Sign in to Facebook in a browser.
2. Export its cookies for `facebook.com` — either a Cookie header string
   (`c_user=…; xs=…; datr=…`) or the JSON any "export cookies" extension emits.
   Both are accepted. `c_user` and `xs` are required; without both, the paste is
   rejected as not-a-login rather than half-working.
3. Save them and lock the file down:

   ```bash
   install -m 600 /dev/null senya-scraper/secrets/fb_cookies.txt
   $EDITOR senya-scraper/secrets/fb_cookies.txt
   docker compose up -d senya-scraper
   ```

`docker compose` already mounts `./senya-scraper/secrets` read-only and points
`FB_COOKIES_FILE` at it. `GET /api/sites` reports `authenticated` so you can
confirm it took. There is also an `FB_COOKIES` env var, but prefer the file:
env vars leak into `docker inspect`, process listings and shell history.

**Treat that file as a password.** A session cookie grants full access to the
account — reading messages, posting, everything. `senya-scraper/secrets/` is
gitignored except for its README. Scraping Marketplace also runs against Meta's
terms of service, and doing it from a signed-in account is what makes an
account actionable, so the risk is no longer purely theoretical. Use a
throwaway account if that matters to you.

If the cookies expire (logging out of the source browser does it), Facebook does
**not** return an error — it quietly serves the ordinary logged-out page, which
still has listings in it. The adapter checks the viewer id Facebook embeds in
every page (`"USER_ID":"0"` when logged out) and says the session is dead,
rather than letting you keep scraping in a silently degraded mode.

**One page only.** Facebook returns ~12–24 listings and paginates over GraphQL
with signed tokens, which is not reachable without a real session.

Since Marketplace is scoped to a city with no national search, `location` is a
required site option (default `toronto`) — use the slug from the URL.
