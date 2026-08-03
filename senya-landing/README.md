# Senya Landing

A **static** homelab landing page: search, bookmarks, live weather, live host
stats, and links to every service (local · Tailscale · external). The layout is
**space-maximizing** on desktop (wide canvas, full-width sections with dense
inner grids) with a **bespoke mobile view** (sticky bar, big tap targets,
bottom-sheet settings). Sections are **show/hide- and drag-reorderable** from a
Customize panel (⚙), saved per-browser.

Designed to be **safe to expose publicly with no auth**: pure static files served
by a hardened, read-only nginx — no backend, no database, no secrets. The only
moving parts are client-side `fetch`es to the public Open-Meteo weather API and
(on-network only) the same-origin `/stats/` proxy.

## Run

```bash
docker compose up --build -d   # → http://localhost:8090
```

## Project structure

No build step — plain native **ES modules** served as-is (works under the strict
`script-src 'self'` CSP). Each section is independent and initialised in
isolation, so one failing piece never blanks the rest of the page.

```
index.html            the page as a list of section slots, nothing else
components/           the markup, one HTML file per section (see below)
  top-bar.html        brand · search · weather chip · clock · health · gear
  bookmarks-bar.html  icon row + the inline add/edit form
  main-table.html     the three columns, as slots
  launcher-rail.html  condensed Senya Apps / Services / Public launchers
  dashboard-grid.html empty grid the registry's widgets are built into
  info-pane.html      permanent right column, as slots
  system-panel.html   live per-host stats block
  settings-drawer.html Customize drawer + backdrop
services.js           INTERNAL config (gated by nginx — see below)
styles/
  base.css            tokens, shell, top bar, search, dashboard, Customize
                      panel, density variables, the mobile @media view
  components.css      bookmarks · weather · system · daily · services
js/
  page.js             composes index.html's slots from components/ (fetch +
                      replace, nestable, cached) — awaited before any init
  config.js           PUBLIC config: BOOKMARKS, WEATHER_LOCATIONS, search engines
  registry.js         declarative SECTIONS list — the source of truth for what
                      sections exist, how they're built, and when they're shown
  layout.js           builds sections from the registry in the saved order,
                      lazily inits each, applies live show/hide + reorder
  settings.js         Customize panel (toggle + Pointer-Events drag reorder)
  utils.js            el() builder, link/iconImg, fetchJSON, safe localStorage
  main.js             entry point: renders the page, then clock, search,
                      bookmarks, rail, system, weather, layout, settings
  sections/           clock · search · bookmarks · weather · system · daily ·
                      rail (each populates its container by id)
```

### Markup: one file per section

`index.html` is just the running order of the page:

```html
<div data-component="top-bar"></div>
<div data-component="bookmarks-bar"></div>
<div data-component="main-table"></div>
<div data-component="settings-drawer"></div>
```

[`js/page.js`](js/page.js) replaces each slot with `components/<name>.html`
(the slot element itself is replaced, so no wrapper divs end up in the DOM) and
resolves nested slots depth-first — `main-table.html` is itself three slots, and
`info-pane.html` two more. Files are fetched once and cached.

- **Reorder the page** → reorder the lines in `index.html`.
- **Add a section** → write `components/<name>.html`, add a slot where it goes
  (top level, or inside another component), and — if it needs behaviour — an
  `initX()` in `js/sections/` called from `js/main.js`.
- **Edit existing markup** → open that one component file; no other file knows
  about its internals, only the ids it exposes.

Markup and behaviour stay separate: components carry no scripts, and each
`init` finds its container by id after `renderPage()` has finished.

## Customize

At runtime (saved per-browser, no code needed): open the **⚙ Customize** panel to
set the size, **show/hide** any section and **drag to reorder** them.

Size is two independent knobs (see [`js/ui-scale.js`](js/ui-scale.js)):

- **Font** — type only (85–140%). Every `font-size` in the stylesheets is
  written `calc(<px> * var(--fs))`, so text grows inside the existing chrome.
- **Zoom** — the whole page (80–160%): type, padding, row heights, the rail and
  the info pane, via root `zoom`, so proportions are preserved.

Order, hidden set and both scales live in `localStorage`
(`senya.sections.order` / `senya.sections.hidden` / `senya.fontScale` /
`senya.uiZoom`).

In code:

- **Bookmarks, weather locations, search engines** → [`js/config.js`](js/config.js)
- **Internal** service list / IPs / SearXNG / stat hosts → [`services.js`](services.js)
- **Add a section**: drop `js/sections/foo.js` exporting `initFoo()` (it populates
  an element by id), then add **one entry** to the `SECTIONS` array in
  [`js/registry.js`](js/registry.js) — `{ id, title, bodyId, bodyClass, init,
  available }`. No markup or `main.js` edits; it appears in Customize automatically.
- **Spacing/density**: tweak the CSS variables in the `:root` of
  [`styles/base.css`](styles/base.css) (and its mobile `@media` block).

Rebuild after editing: `docker compose up --build -d`.

## Modularity & lifecycle

Each section is described once in [`js/registry.js`](js/registry.js): its shell
(heading + body container), its `init`, and an `available()` predicate (e.g.
internal-only sections are unavailable off-network, so they're never built). The
layout manager builds a section's shell and runs its `init` **lazily, the first
time it's shown** — so a section hidden by default never polls in the background.
Toggling it off keeps the node in the DOM (instant re-show, no re-fetch); drag
reordering just moves the existing nodes. One section throwing never blanks the
rest — each `init` runs in its own try/catch.

## Sections

- **Weather** — Open-Meteo (no API key), and it lives entirely in the **top bar**
  (there's no side-pane block): a condensed chip shows icon · temp · today's
  high/low · rain chance and wind, and clicking it expands location pills,
  current conditions, the next 24 hours and a 7-day forecast. Shown on and off
  network.
- **System** — live CPU/RAM/SSD/temp per host via each host's Glances API,
  reverse-proxied same-origin under `/stats/<host>/` (internal only). Each host
  name carries small **LAN** / **TS** chips — click one for a popup with the
  address, click the address to copy it; set `ip`/`ts` per host in `HOSTS`
  (`services.js`).
- **Services** (launcher rail) — click a service for its reachability links:
  **LAN**, **TS** (Tailscale) and, if it has an `ext` subdomain, **EXT**
  (`https://<ext>.senya.ca`) — each opens in a new tab. Whether you leave the
  rail expanded or compact is remembered (`senya.rail.expanded`). Internal only.
- **Bookmarks** — icon row under the top bar; the trailing **✎+** cell is edit
  and add at once (add form opens with edit mode; click a tile to edit it, ✕ to
  delete). Saved in `localStorage` over the `BOOKMARKS` defaults.
- **Market Map** — the S&P 500 as blocks, finviz-style: a squarified treemap
  where each company's area is its market cap and its colour is its performance
  over the selected period (1D · 1W · 1M · 3M · 1Y · YTD), grouped by sector.
  Structure (sector / ticker / market cap) is a static snapshot in
  `data/market-map.json`; live percentages come from finviz's JSON through
  nginx's cached `/market/perf` proxy (they send no CORS headers). Refresh the
  snapshot with `tools/extract-map-structure.py` — see below.
- **Crypto** — prices, 24h change and market cap from CoinGecko's free API (no
  key). Coins: `CRYPTO_COINS` in [`js/config.js`](js/config.js).
- **Search** (Google + SearXNG on-network). SearXNG is picked to match the
  address you loaded the page from: reach the landing page over Tailscale and
  the search goes to `SEARXNG_TS`, over the LAN and it goes to `SEARXNG` (both
  in [`services.js`](services.js)). Any other hostname — a MagicDNS name,
  `localhost` — reuses that hostname with SearXNG's port.

### Refreshing the market map snapshot

Index membership and market caps move quarterly, so the structure is a snapshot
rather than a live fetch. finviz ships it in a content-hashed webpack chunk:

```bash
# 1. find the chunk the map page preloads (data-chunk-id="map_base_sec")
curl -s https://finviz.com/map | grep -o '/assets/dist/[0-9]*\.v1\.[a-f0-9]*\.js'
# 2. pull it and re-extract
curl -s https://finviz.com/assets/dist/<that-file> -o /tmp/base.js
python3 tools/extract-map-structure.py /tmp/base.js data/market-map.json
```

## Network-aware internal sections

The Services and System sections (and the SearXNG search option) only appear on
your **LAN or Tailscale**. This isn't just UI hiding: the internal data lives in
[`services.js`](services.js), and **nginx refuses to serve that file to public
requests** (gated by `Host` header). The `/stats/` proxy is gated the same way.

| How you reach it | `Host` | `services.js` | Internal sections |
|---|---|---|---|
| LAN | `192.168.2.100` | served | yes |
| Tailscale | `100.121.230.17` | served | yes |
| Tunnel (public) | `home.senya.ca` | **404** | no |

## Hardening applied

- Static files only (nginx:alpine), **read-only** root filesystem + tmpfs
- `no-new-privileges`
- `GET`/`HEAD` only (others → 405), `autoindex off`, `server_tokens off`
- Strict **CSP**: `default-src 'self'`, no inline JS/CSS; `connect-src` limited to
  `'self'` + `https://api.open-meteo.com` (weather)
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`
- External links use `target="_blank" rel="noopener noreferrer"`

## Expose via Cloudflare Tunnel

The tunnel is dashboard-managed (token mode), so add a public hostname in
**Zero Trust → Networks → Tunnels → your tunnel → Public Hostnames**:

- Subdomain `home` (or any name) · Domain `senya.ca`
- Service: `HTTP` → `senya-landing:80`

> Topology note: the internal sections list internal IPs/ports, but nginx never
> serves them to off-network visitors (RFC1918 + Tailscale CGNAT gating), so they
> aren't disclosed publicly.
