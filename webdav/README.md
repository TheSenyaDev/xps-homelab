# WebDAV (Boox notes sync)

A tiny [hacdias/webdav](https://github.com/hacdias/webdav) server so an Onyx Boox
e-reader can sync its notes/exports to the homelab over WebDAV. Files land in
`./webdav/data` on the host.

```
Boox  ──WebDAV (Basic auth)──►  http://192.168.2.100:8085  ──►  ./webdav/data/*
```

## Run

Part of the root stack:

```bash
docker compose up -d webdav
```

## Config

- **URL:** `http://192.168.2.100:8085` (LAN) or `http://100.121.230.17:8085` (Tailscale)
- **Username / password:** `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` in [`../.env`](../.env)
- Server settings (port, directory, permissions) live in [`config.yml`](config.yml).
  Credentials are pulled from the environment via `"{env}VAR"`, so no secrets are
  committed.

## Set it up on the Boox

1. On the Boox, open the **Notes** app (or **Storage** → sync) and add a
   **WebDAV** account.
2. **Server address:** `http://192.168.2.100:8085`  (use the Tailscale IP
   `http://100.121.230.17:8085` if syncing off your LAN).
3. Enter the **username** and **password** from `.env`.
4. Pick the folder/notes to sync — they'll appear under `./webdav/data` here.

> The Boox WebDAV client speaks plain HTTP Basic auth and is fussy about
> trailing slashes; if a connection test fails, retry with a trailing `/` on the
> URL. To reach it from outside the LAN, prefer Tailscale rather than a public
> Cloudflare hostname (this share has no Authelia in front of it).

## Verify from a desktop

```bash
# List the share (should return XML, not 401)
curl -u "$WEBDAV_USERNAME:$WEBDAV_PASSWORD" -X PROPFIND \
  -H 'Depth: 1' http://192.168.2.100:8085/

# Upload + read back a test file
curl -u "$WEBDAV_USERNAME:$WEBDAV_PASSWORD" -T hello.txt http://192.168.2.100:8085/hello.txt
curl -u "$WEBDAV_USERNAME:$WEBDAV_PASSWORD" http://192.168.2.100:8085/hello.txt
```
