# Senya Landing

A dead-simple **static** landing page for the senya homelab: bookmarks, a
Google/SearXNG search box, and links to every service (local + Tailscale).

Designed to be **safe to expose publicly with no auth**: it's pure static files
served by a hardened, read-only nginx — no backend, no database, no API, no
secrets, nothing to exploit.

## Run

```bash
docker compose up --build -d   # → http://localhost:8090
```

## Customize

- Public-safe config (bookmarks, Google search) → top of [`app.js`](app.js)
- **Internal** config (service list, internal IPs, SearXNG) → [`services.js`](services.js)

Rebuild after editing: `docker compose up --build -d`.

## Network-aware Services section

The Services section (and the SearXNG search option) only appear when you're on
your **LAN or Tailscale** — they're hidden when the page is reached publicly via
the tunnel. This isn't just UI hiding: the internal data lives in
[`services.js`](services.js), and **nginx refuses to serve that file to public
requests** (gated by `Host` header — private/Tailscale ranges only). So the
internal IPs/ports are never sent to an off-network visitor at all.

| How you reach it | `Host` | `services.js` | Services shown |
|---|---|---|---|
| LAN | `192.168.2.100` | served | yes |
| Tailscale | `100.121.230.17` | served | yes |
| Tunnel (public) | `home.senya.ca` | **404** | no |

## Hardening applied

- Static files only (nginx:alpine), **read-only** root filesystem + tmpfs
- `no-new-privileges`
- `GET`/`HEAD` only (others → 405), `autoindex off`, `server_tokens off`
- Security headers: strict **CSP** (`default-src 'self'`, no inline JS/CSS),
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`
- External links use `target="_blank" rel="noopener noreferrer"`

## Expose via Cloudflare Tunnel

The tunnel is dashboard-managed (token mode), so add a public hostname in
**Zero Trust → Networks → Tunnels → your tunnel → Public Hostnames**:

- Subdomain `home` (or any name) · Domain `senya.ca`
- Service: `HTTP` → `senya-landing:80`

> ⚠️ Topology note: this page lists internal IPs/ports. Those aren't reachable
> from the internet (RFC1918 + Tailscale CGNAT), but publishing them does reveal
> what you run. See the chat notes for how to gate the Services section if you'd
> rather not disclose it publicly.
