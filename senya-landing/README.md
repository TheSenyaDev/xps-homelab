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
index.html            shell: sticky top bar + search + empty #dashboard
services.js           INTERNAL config (gated by nginx — see below)
styles/
  base.css            tokens, shell, top bar, search, dashboard, Customize
                      panel, density variables, the mobile @media view
  components.css      bookmarks · weather · system · daily · services
js/
  config.js           PUBLIC config: BOOKMARKS, WEATHER_LOCATIONS, search engines
  registry.js         declarative SECTIONS list — the source of truth for what
                      sections exist, how they're built, and when they're shown
  layout.js           builds sections from the registry in the saved order,
                      lazily inits each, applies live show/hide + reorder
  settings.js         Customize panel (toggle + Pointer-Events drag reorder)
  utils.js            el() builder, link/iconImg, fetchJSON, safe localStorage
  main.js             entry point: clock, search, layout, settings (try/catch)
  sections/           clock · search · bookmarks · weather · system · daily ·
                      public · services (each populates its container by id)
```

## Customize

At runtime (saved per-browser, no code needed): open the **⚙ Customize** panel to
**show/hide** any section and **drag to reorder** them. Order + hidden set live in
`localStorage` (`senya.sections.order` / `senya.sections.hidden`).

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
