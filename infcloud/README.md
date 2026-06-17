# InfCloud (CalDAV / CardDAV web client)

Browser-based client for viewing/editing the calendars and address books in
[Baïkal](../baikal/README.md) — no app install needed. InfCloud is the combined
build of **CalDavZAP** (calendars/tasks) + **CardDavMATE** (contacts).

Built from this directory (see [docker-compose.yaml](../docker-compose.yaml),
`infcloud` service). App source comes from `ckulka/infcloud` (v0.13.1).

| What | URL |
|------|-----|
| Web UI    | `http://192.168.2.100:5233/` |
| Tailscale | `http://100.121.230.17:5233/` |

- **Port:** 5233
- **Log in with:** a Baïkal username + password (e.g. `Senya`). The username is
  typed on InfCloud's login screen; nothing is hardcoded in the image.

## How it connects to Baïkal (and why there's no CORS config)

A browser app on one origin (`:5233`) talking to Baïkal on another (`:5232`)
would be blocked by the same-origin policy and would need CORS headers on
Baïkal. To avoid that entirely, the nginx in this container does two jobs:

1. serves the InfCloud static app, and
2. reverse-proxies `*.php` DAV paths (`/dav.php/`, `/cal.php/`, `/card.php/`, …)
   to the `baikal` container.

So the browser only ever makes **same-origin** requests to `:5233` — calendars
and contacts are proxied through. See [default.conf](default.conf).

`config.js` is the stock InfCloud config with [config.override.js](config.override.js)
appended at build time, setting `globalNetworkCheckSettings.href` to
`location.host + '/dav.php/principals/'` (the proxied, same-origin Baïkal
principal collection). `location.host` keeps it correct over LAN, Tailscale, or
a future `cal.senya.ca`.

## Requirement: Baïkal must use Basic auth

InfCloud's XHR cannot perform Digest authentication, so Baïkal is set to
`dav_auth_type: Basic` (`../baikal/config/baikal.yaml`). All other clients
(DAVx⁵, Thunderbird, iOS, Evolution) also support Basic. Basic sends base64
credentials per request — fine over LAN/Tailscale, so don't expose Baïkal
publicly over plain HTTP.

## Rebuild after a config change

`config.js` is baked into the image, so re-build (and InfCloud also ships an old
HTML5 appcache `cache.manifest` — modern browsers ignore it, but hard-refresh if
you see stale behaviour):

```bash
docker compose up -d --build infcloud
```

## Notes / TODO

- Plain HTTP, not behind Traefik. For remote use go through Tailscale.
- To get `cal.senya.ca` with TLS: add a Traefik router + Cloudflare hostname
  (same pattern as the other `*.senya.ca` services). The same-origin proxy means
  the public hostname works without extra CORS setup.
