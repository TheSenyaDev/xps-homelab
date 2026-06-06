# Senya Landing

A **static** homelab landing page: search, bookmarks, live weather, live host
stats, and links to every service (local · Tailscale · external). Two view
densities — **Comfortable** and **Compact** — toggled in the header.

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
index.html            markup + section containers
services.js           INTERNAL config (gated by nginx — see below)
styles/
  base.css            tokens, layout, header, search, density variables
  components.css      bookmarks · weather · system · services
  compact.css         compact-view overrides (retunes the density variables)
js/
  config.js           PUBLIC config: BOOKMARKS, WEATHER_LOCATIONS, search engines
  utils.js            el() builder, link/iconImg, fetchJSON, safe localStorage
  views.js            Comfortable/Compact toggle (persisted)
  main.js             entry point; runs each section in try/catch
  sections/           clock · search · bookmarks · weather · system · services
```

## Customize

- **Bookmarks, weather locations, search engines** → [`js/config.js`](js/config.js)
- **Internal** service list / IPs / SearXNG / stat hosts → [`services.js`](services.js)
- **Add a section**: drop `js/sections/foo.js` exporting `initFoo()`, add a
  container in `index.html`, and register it in [`js/main.js`](js/main.js).
- **Spacing/density**: tweak the CSS variables in `styles/base.css` (comfortable)
  and `styles/compact.css` (compact).

Rebuild after editing: `docker compose up --build -d`.

## Views

A header toggle switches between **Comfortable** (roomy cards) and **Compact**
(denser grids, smaller type, wider canvas — more info per screen). The choice is
saved in `localStorage` and applied as a `body.compact` class, so the difference
is pure CSS.

## Sections

- **Weather** — Open-Meteo (no API key); current conditions + a 7-day forecast,
  with a selectable set of locations. Shown on and off network.
- **System** — live CPU/RAM/SSD/temp per host via each host's Glances API,
  reverse-proxied same-origin under `/stats/<host>/` (internal only).
- **Services** — each service links to **local**, **ts** (Tailscale), and, if it
  has an `ext` subdomain, **ext** (`https://<ext>.senya.ca`). Internal only.
- **Bookmarks** / **Search** (Google + SearXNG on-network).

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
