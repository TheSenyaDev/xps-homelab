# SenyaScraper

Marketplace product search. Queries several second-hand sites at once and, for
searches you save, reports what changed since last time: which listings are
**new** and which **dropped in price**.

That diff is the point. Running the same search by hand every day and trying to
spot what moved is the job a computer should do.

Implemented: **eBay.ca**, **Facebook Marketplace**.

```bash
docker compose up --build -d senya-scraper   # → http://localhost:8005
```

---

## 1. Features

### 1.1 Search

| Feature | What it does |
|---|---|
| Live search | Scrape now, persist nothing. |
| Multi-market | One query across every selected market; `sites: "all"` or a list. |
| Shared filters | Query, sort, condition, price range — the ones every site has. |
| Per-site filters | Each adapter declares its own; see §1.2. |
| Categories | Per-site taxonomies (eBay ships 12 top-level). |

**Merging** is not concatenation — sites share no rank:

| Sort | Strategy |
|---|---|
| `price-asc` / `price-desc` | Real shared scale; sorted across everything. Listings with no single price (auction ranges) sort **last in both directions** rather than pretending to be free. |
| `newest` | Only meaningful where the site dates listings, and eBay does not. Dated lead in order; undated follow, interleaved. |
| `best` | No cross-site meaning. Round-robin, so one market cannot bury the other. |

**Partial failure is expected**, not exceptional: markets throttle
independently. A combined search returns whatever came back plus a per-site
`errors` list. Only when *every* market fails is it a 502.

### 1.2 Per-site options

Anything one site can filter by and others cannot is declared by its adapter and
rendered by the UI from that declaration.

- **eBay** — buying format (BIN / auction / best offer), item location, free
  shipping, returns accepted, sold & completed listings.
- **Facebook** — city (required: Marketplace is city-scoped with no national
  search), radius, listed-within.

Values are stored **keyed by site**, so a profile switched between markets keeps
each one's configuration independently.

### 1.3 Saved searches

- Named profiles with full criteria; create and edit from one dialog.
- **Re-run diff** — new listings and price drops since last run.
- Every listing ever seen is retained, so a returning listing is not
  re-announced as new.
- Editing keeps stored listings: tightening a price ceiling should not make
  everything already seen look new.
- A market that **errored** is skipped when flagging listings gone — they are
  absent because we could not ask, not because they sold.

### 1.4 Item panel

Clicking a result opens it. Shows everything the search returned — price and
previous price, condition, shipping, seller, location, posted date, market —
plus:

- **Open on site** — the listing itself.
- **Block this seller** — scoped to that listing's market (§1.5).
- **Load full details** — fetches the listing's own page for the description,
  full photo set and item specifics. On demand, not automatic: it is one request
  per item, and doing it for 60 results would get the session throttled at once.
  eBay only; Facebook's detail pages need real JS.

### 1.5 Seller blocklist

**Per search and per marketplace.** Per search because a seller who floods one
query with junk may be exactly who you want for another. Per marketplace because
seller identities are not shared — `acme` on eBay is an account handle, *Acme* on
Facebook is a display name, and they are unrelated. Blocking one never blocks
the other, and the API refuses a block that does not name its market.

Set it from the ⊘ on a card, the button in the item panel, or one box per market
in the edit dialog. Legacy flat lists are still read, attributed to the search's
primary site.

Filtered locally rather than via a site-side exclusion, since not every
marketplace has one. Blocked listings are **never stored**, so unblocking later
cannot announce a seller's whole back catalogue as new — but they *are* returned
to the UI, where a **Show blocked** switch reveals them greyed out with an
unblock button. Seeing what a block costs you is how you notice it was too broad.

Requires seller data: Facebook exposes none when logged out, so the field is
hidden there until a session is supplied.

### 1.5 Anti-detection (`scraper/http/`)

Detection works in layers. The ones people skip are the ones that identify them.

| Layer | The tell | What this does |
|---|---|---|
| **TLS (JA3/JA4)** | `requests`/`urllib3` emit a ClientHello matching no real browser, checked before a byte of HTTP is parsed | `curl_cffi` impersonates Chrome's real handshake |
| **HTTP/2** | `requests` cannot speak h2, so "Chrome" arrives over HTTP/1.1 — encoded in the JA4 itself (`…h1_` vs `…h2_`) | real Chrome SETTINGS, window sizes, `m,a,s,p` pseudo-header order |
| **Headers** | wrong *order*; missing `Sec-Ch-Ua`; a macOS UA with `Sec-Ch-Ua-Platform: "Windows"` | one profile fixes UA, hints, platform and order together |
| **Pacing** | a fixed delay is a signature | triangular jitter between min and max |
| **Session** | a fresh cookie jar every process start | jars persisted per site (0600), warm-up navigation, honest `Referer` |

Measured on `tls.peet.ws`:

```
python-requests   JA4 t13d1713h1_ab0a1bf427ad_…   HTTP/1.1
this fetcher      JA4 t13d1516h2_8daaf6152771_…   h2
                  akamai 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
```

A profile is only useful if **every layer agrees**. Claiming Chrome 131 while
presenting Chrome 124's handshake is *more* identifying than sending nothing,
because real traffic is never self-contradictory — hence one `BrowserProfile`
bundling all of it. Safari's profile sends no client hints, which is correct for
Safari.

Requests are paced per domain, globally across threads, so several tabs still
add up to a civil rate.

### 1.6 Signed-in sessions

Optional. Reuses a session **you** established in a browser, supplied as cookies
(Cookie header or exported JSON).

**No password is ever handled**, deliberately: Facebook checkpoints scripted
logins immediately and would demand 2FA, so automating the form would not work
*and* would mean storing credentials.

Read from `FB_COOKIES_FILE` in preference to `FB_COOKIES` — a session cookie is
as good as the password, and env vars leak into `docker inspect` and process
listings. Compose mounts `./senya-scraper/secrets` read-only; it is gitignored.

```bash
install -m 600 /dev/null senya-scraper/secrets/fb_cookies.txt
$EDITOR senya-scraper/secrets/fb_cookies.txt      # c_user and xs required
docker compose up -d senya-scraper
```

Signing in adds seller names (enabling the blocklist) and returns more results.
Expired cookies are detected: Facebook serves an ordinary logged-out page rather
than an error, so the adapter checks the embedded viewer id (`"USER_ID":"0"`).

**Treat the file as a password** — a session cookie grants full account access.

### 1.7 Settings (⚙)

Runtime settings, no restart. Every control is rendered from a server-side
schema, so adding one never touches the frontend. Stored in
`/data/settings.json`.

| Group | Settings |
|---|---|
| Fingerprint | transport (auto / curl_cffi / requests), browser profile |
| Pacing | jitter on/off, pace multiplier, retries |
| Session | warm-up, Referer chains, cookie persistence, proxy URL |
| Search | parallel markets, keep partial results |
| Markets | enable/disable each site |

Settings **overlay** an adapter's baseline rather than replacing it — Facebook
still needs longer gaps than eBay whatever the multiplier. Changing anything
under `http.` rebuilds the fetchers immediately. The page shows live transport
state, so "am I still fingerprintable as Python?" is verifiable rather than
assumed.

### 1.8 Notifications

Event bus: a run emits `listings.new` / `listings.price_drop` and never learns
who is listening. Handlers cannot fail the request that triggered them.

A log channel ships enabled, so the path is never silent before a real channel
is configured.

---

## 2. Architecture

Every layer is extended by **adding a file**, not editing a hub.

```
app.py                  WSGI entrypoint — nothing but create_app()
scraper/
  __init__.py           app factory: config, db, blueprints, notifiers
  db.py                 SQLite + append-only migrations
  settings.py           runtime settings schema + store
  events.py             event bus
  aggregate.py          multi-market fan-out, partial failure, rank merging
  api/                  blueprints: sites · search · searches · settings
  sites/                base.py + one file per marketplace (self-registering)
  notify/               base.py + one file per channel (self-registering)
  http/                 profiles.py · backends.py · fetcher.py
static/                 vanilla JS, no build step
```

| To add | Do this | Wiring |
|---|---|---|
| A marketplace | `sites/<name>.py` | none — self-registers |
| A notification channel | `notify/<name>.py` | none — self-registers |
| A browser profile | entry in `profiles.PROFILES` | none |
| A transport | `Backend` subclass in `backends.BACKENDS` | none |
| A site filter | `Option` in the adapter | none — UI renders it |
| A setting | `Setting` in `settings.SCHEMA` | none — UI renders it |
| An endpoint group | `api/<name>.py` | one line in `MODULES` |
| A schema change | append to `db.MIGRATIONS` | none |

### Adding a marketplace

```python
# scraper/sites/kijiji.py
from ..http import FetchPolicy
from .base import Listing, Scraper, SearchOptions, clean, parse_price

class Kijiji(Scraper):
    key, label, domain = "kijiji", "Kijiji", "www.kijiji.ca"
    policy = FetchPolicy(profile="chrome-win", min_interval=3, max_interval=9,
                         warmup_url="https://www.kijiji.ca/")

    def search(self, opts: SearchOptions) -> list[Listing]:
        res = self.get(...)   # paced, impersonated, retried, error-shaped
        return [...]
```

Declare what the site can honour (`supports_sort`, `supports_price_range`,
`supports_seller`, …) and the UI greys out what it cannot, rather than offering
a control that silently does nothing.

---

## 3. API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/sites` | sites, `supports` flags, categories, options, auth state |
| `GET` | `/api/health` | backend, whether TLS impersonation is active, per-site fetchers |
| `GET`/`PUT` | `/api/settings` | schema + values; PUT rebuilds fetchers |
| `POST` | `/api/search` | live; `sites` may be a list or `"all"` |
| `GET`/`POST` | `/api/searches` | list / create |
| `GET`/`PATCH`/`DELETE` | `/api/searches/<id>` | PATCH takes a partial payload |
| `POST` | `/api/searches/<id>/run` | → `{new, price_drops, hidden, errors, results}` |
| `POST` | `/api/searches/<id>/block` | `{seller, site}`; add `unblock: true` to reverse |
| `POST` | `/api/detail` | `{site, url}` → description, photos, specs |
| `GET` | `/api/searches/<id>/results` | stored listings (`?include_gone=1`) |

**Status codes.** `400` is your mistake (no query, unknown site). `502` means
the marketplace refused or changed shape — a real occurrence, not a bug here.

---

## 4. Site notes

### eBay.ca

- Cold `/sch/` returns **403**; the homepage first earns a session.
- Rate limiting arrives as **HTTP 200** — a *"Pardon Our Interruption"*
  interstitial that parses as a valid empty page. Detected and reported as
  throttling, not as "markup changed".
- Results use `.s-card`, **not** the `.s-item` older guides describe.
- Every card's footer reads `derosnopS` — "Sponsored" reversed to defeat
  scrapers. It appears on organic listings too, so it is not a usable flag.
- Placeholder *"Shop on eBay"* cards (`/itm/123456`) and the screen-reader text
  hidden in every title are stripped.

### Facebook Marketplace

- Listings are **not in the HTML** — CSS selectors cannot work. They sit in a
  Relay payload inside `<script type="application/json">`, walked for nodes
  carrying `marketplace_listing_title`.
- Cold requests **400**, homepage included; cookie priming fixes it.
- A **200 can still be a logged-out shell** with no data. That is throttling and
  is reported differently from "no matches".
- Throttles far harder than eBay — 6 s floor against 1.5 s.
- One page (~12–24). Pagination uses GraphQL with signed tokens.
- No seller data when logged out.

Markup changes without warning. An adapter returning nothing usually means
selectors, not a crash — `search()` raises a distinct error for "page loaded but
nothing recognisable" so it is never mistaken for an empty shelf.

---

## 5. Possible improvements

Roughly by value per unit of work.

### Scraping reach

- **More marketplaces** — Kijiji and AutoTrader both respond from this host; no
  adapter written yet. Each is one file.
- **Pagination** — every adapter returns page 1 only. `SearchOptions.page`
  exists and is unused by the API.
- **Facebook detail pages** — eBay's are implemented; Facebook's need real JS,
  so they wait on a headless backend.
- **Currency normalisation** — eBay returns USD listings on `.ca`. `Listing`
  carries `currency`, but cross-site price sorting compares the numbers without
  converting. Correctly a daily FX fetch plus a `price_cad` field.

### Anti-detection

- **Headless-browser backend** — a `Backend` subclass wrapping Playwright, for
  sites needing real JS. Would unlock Facebook pagination and Cloudflare-gated
  sites. The interface already accommodates it.
- **Proxy pool** — the `proxy` field takes one; rotation needs a pool object and
  health tracking. Only worth it if the residential IP is lost.
- **Per-site profile pinning** — currently one profile across all sites. A
  distinct profile per site is more plausible than every site seeing the same
  browser from the same IP.
- **`Sec-Ch-Ua-Full-Version-List`** and other high-entropy hints, which Chrome
  sends after a server requests them via `Accept-CH`. Currently unhandled.

### Product

- **Scheduled runs** — saved searches only run when clicked. A background
  scheduler plus the existing event bus is what makes notifications useful.
  Largest single gap.
- **Real notification channels** — ntfy, Discord, email. ~8 lines each; only the
  log channel exists.
- **Price history** — `first_price` and `price` are stored, but only the latest
  value is kept. A `price_history` table would enable sparklines and
  "cheapest ever seen".
- **Cross-site duplicate detection** — an item cross-posted to eBay and Facebook
  appears twice. Fuzzy title + price matching could collapse them.
- **Saved-search folders**, once there are enough to need grouping.
- **Result-level filters** — client-side narrowing (keyword exclude, hide
  no-image) without re-scraping.

### Operational

- **Tests.** There are none. The parsers are the fragile part and are pure
  functions over saved fixtures — cheap to cover, and would catch markup drift
  before a search does.
- **Adapter health checks** — a periodic canary query per site, so breakage is
  noticed before you need it rather than at the moment you search.
- **Structured run history** — a `runs` table (when, site, count, error) would
  make throttling patterns visible instead of anecdotal.

---

## 6. Limits worth knowing

- **Volume beats every trick here.** A few searches a day is indistinguishable
  from a person by rate alone. Most scrapers are caught doing 10k requests an
  hour, not on a fingerprint.
- **A residential IP is the single biggest asset.** Moving this to a VPS would
  cost more than any technique above would recover.
- **`curl_cffi` 0.7.4 tops out at chrome124**, so profiles claim 124 rather than
  a newer version they cannot actually present.
- **Scraping these sites is against their terms.** Fine at homelab volume; the
  calculus changes on the signed-in Facebook path, where the risk becomes the
  account rather than a 403. Being boring there is safer than being clever.
