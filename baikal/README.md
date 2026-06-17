# Baïkal (CalDAV / CardDAV)

Self-hosted calendar + contacts server. Defined in [docker-compose.yaml](../docker-compose.yaml)
(`baikal` service, `ckulka/baikal:nginx`). Data lives in `./data` (SQLite at
`data/db/db.sqlite`), config in `./config/baikal.yaml`.

## Endpoints

| What        | URL                                                       |
|-------------|-----------------------------------------------------------|
| Admin UI    | `http://192.168.2.100:5232/admin/`                        |
| DAV base    | `http://192.168.2.100:5232/dav.php/`                      |
| Principal   | `http://192.168.2.100:5232/dav.php/principals/<user>/`    |
| Calendar    | `http://192.168.2.100:5232/dav.php/calendars/<user>/<cal>/` |
| Web client  | `http://192.168.2.100:5233/` (InfCloud — see `../infcloud/README.md`) |
| Tailscale   | swap host for `100.121.230.17` (same port/paths)          |

- **Port:** 5232
- **Auth:** Basic (`dav_auth_type: Basic` in `config/baikal.yaml`). Was Digest;
  switched to Basic because the InfCloud web client can't authenticate with
  Digest. All other clients (DAVx⁵, Thunderbird, iOS, Evolution) speak Basic too.
  Basic sends base64 creds per request, so keep this on LAN/Tailscale (no public
  plain-HTTP exposure).
- **TLS:** none — served plain HTTP. Not behind Traefik. For remote access use
  Tailscale, not a port-forward.

## First-time setup

1. Open the admin UI → log in as `admin`.
2. **Users** → add a user (these creds are what clients authenticate with).
3. Select the user → **Calendars** → add a calendar. A client can't discover
   anything until at least one calendar exists.

## Subscribing a client

Point the client at the **principal** URL for auto-discovery (finds all
calendars + address books), or a specific **calendar** URL for one calendar.
Use the user's Baïkal credentials; auth type is Basic.

For a browser-based client (no app install), use **InfCloud** at
`http://192.168.2.100:5233/` — see `../infcloud/README.md`.

### Android — DAVx⁵
1. Add account → *Login with URL and user name*.
2. Base URL: `http://192.168.2.100:5232/dav.php/principals/<user>/`
3. Enter username + password → pick calendars/contacts to sync.
4. Stock Calendar/Contacts apps then show them.
   - Off-LAN: install Tailscale and use `100.121.230.17`.

### iOS / macOS
- Settings → Calendar → Accounts → Add → Other → **Add CalDAV Account**.
- Server: `192.168.2.100:5232`, username/password.
- If not auto-found, set Advanced path to `/dav.php/principals/<user>/`.
- Note: iOS dislikes plain-HTTP CalDAV — prefer Tailscale, or front it with TLS.

### Thunderbird
- New Calendar → On the Network → **CalDAV** → Location:
  `http://192.168.2.100:5232/dav.php/calendars/<user>/<cal>/`

### Evolution / GNOME
- Accounts → CalDAV → URL
  `http://192.168.2.100:5232/dav.php/calendars/<user>/<cal>/`, Basic auth.

## Importing an existing calendar

Baïkal has no .ics import page. Connect a desktop client (Thunderbird,
macOS Calendar) to the target Baïkal calendar, then use its File → Import to
load an exported `.ics`. Or PUT events directly:

```bash
curl -u USER:PASS \
  -X PUT -H "Content-Type: text/calendar" \
  --data-binary @event.ics \
  http://192.168.2.100:5232/dav.php/calendars/USER/CAL/event.ics
```

## Notes / TODO

- Served over plain HTTP. To get `dav.senya.ca` with TLS, add a Traefik router
  + Cloudflare tunnel entry (same pattern as the other `*.senya.ca` services).
