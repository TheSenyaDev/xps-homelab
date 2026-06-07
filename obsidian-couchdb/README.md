# Obsidian Self-hosted LiveSync (CouchDB)

A **CouchDB** backend for the Obsidian **Self-hosted LiveSync** community plugin —
sync one vault across all your devices (desktop, phone, the browser instance at
`:8080`), self-hosted, no Obsidian Sync subscription.

- Server: `http://192.168.2.100:5984` (LAN) · `http://100.121.230.17:5984` (Tailscale)
- Admin UI (Fauxton): `http://192.168.2.100:5984/_utils`
- Credentials: `COUCHDB_USER` / `COUCHDB_PASSWORD` in the root `.env`
- Sync database: `obsidian` (already created)

CouchDB is pre-configured for LiveSync in [`local.ini`](local.ini): auth required
on every request, CORS allowed for the Obsidian apps, and large request/document
sizes. Secrets are **not** stored here — the admin is injected from `.env` into
CouchDB's own `docker.ini` on each boot.

## Set up a device

1. In Obsidian: **Settings → Community plugins → Browse**, install
   **"Self-hosted LiveSync"**, then enable it.
2. Open its settings → **Remote Database configuration**:
   - **URI:** `http://192.168.2.100:5984` on the LAN, or
     `http://100.121.230.17:5984` from a phone/laptop on Tailscale.
   - **Username / Password:** the values from `.env`
     (`grep -E 'COUCHDB_(USER|PASSWORD)' .env`).
   - **Database name:** `obsidian`
   - Click **Test Database Connection** → should say *Connected*. (CORS/auth are
     already set, so the plugin's "check config" should report all-green.)
3. Set an **End-to-End encryption passphrase** (recommended) — the same passphrase
   on every device.
4. **First device:** choose *"This device has the data I want to keep"* and let it
   replicate up. **Other devices:** *"Fetch from remote"*.
5. Turn on **LiveSync** (real-time) mode, or Periodic + on-save if you prefer.

For the browser instance (`obsidian-remote`), use the same steps; on the same
docker network it can also reach the DB at `http://obsidian-couchdb:5984`.

## Sync from off-network (phone on cellular)

Easiest is Tailscale (works as-is). To use the Cloudflare tunnel instead, add a
route in `traefik/dynamic/routes.yml` for `couchdb.senya.ca` → `http://obsidian-couchdb:5984`
**without** the Authelia middleware (LiveSync authenticates to CouchDB directly,
so a forward-auth login page would break it), add the Cloudflare hostname
(→ `http://traefik:80`), then set the plugin URI to `https://couchdb.senya.ca`.
CORS already permits the Obsidian app origin.

## Maintenance

```bash
docker compose logs -f obsidian-couchdb     # logs
# Fauxton (DB browser/admin):  http://<host>:5984/_utils
```

The vault data lives in `./data/` (git-ignored). Compacting/cleanup is handled
from the LiveSync plugin (Hatch tab) — e.g. "Rebuild everything" if sync ever gets
into a bad state.

## Config

| Item | Value |
|------|-------|
| Image | `couchdb:3` |
| Port | `5984` |
| Admin | `COUCHDB_USER` / `COUCHDB_PASSWORD` (root `.env`) |
| Static config | `local.ini` → mounted as `…/local.d/00-livesync.ini` |
| Data | `./data` (git-ignored) |
