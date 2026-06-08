# LiveSync Bridge

A headless replicator from the **Self-hosted LiveSync** author
([vrtmrz/livesync-bridge](https://github.com/vrtmrz/livesync-bridge)) that speaks
LiveSync's own **chunk + end-to-end-encryption** format. It connects to the
Obsidian CouchDB and **materializes the vault as plain `.md` files** in a folder —
and watches that folder to push edits back up. Bidirectional, no Obsidian app
involved.

This is what makes [`senya-notes`](../senya-notes/README.md) possible: that app is
a dumb plain-file editor, and this sidecar is the thing that turns the chunked,
encrypted CouchDB documents into real markdown (and back).

```
phone / desktop Obsidian ──LiveSync──► obsidian-couchdb (:5984)
                                              ▲
                                              │  livesync-bridge (this, Deno)
                                              ▼   speaks chunks + E2E
                                  ./data/vault/*.md  ◄─ shared ─►  senya-notes (:8003)
```

## Configuration — all via `.env`

There is **no config file to edit**. On every boot, [`render-config.ts`](render-config.ts)
generates `/app/dat/config.json` from environment variables, so the only place
secrets live is the root `.env`:

| `.env` var | Meaning |
|------------|---------|
| `COUCHDB_USER` / `COUCHDB_PASSWORD` | CouchDB login (shared with the `obsidian-couchdb` service) |
| `LIVESYNC_DATABASE` | sync database name (default `obsidian`) |
| `LIVESYNC_COUCHDB_URL` | internal URL (default `http://obsidian-couchdb:5984`) |
| `LIVESYNC_E2E_PASSPHRASE` | your plugin's **End-to-End encryption passphrase** — leave empty only if E2E is off |
| `LIVESYNC_OBFUSCATE_PASSPHRASE` | same passphrase **only if** *path obfuscation* is enabled, else empty |

> ⚠️ `LIVESYNC_E2E_PASSPHRASE` / `LIVESYNC_OBFUSCATE_PASSPHRASE` must match the
> Obsidian "Self-hosted LiveSync" plugin **exactly**. If they don't, the bridge
> produces empty/garbled files with **no error message**. That's the one thing to
> get right.

## Start it

```bash
docker compose up -d --build livesync-bridge
docker compose logs -f livesync-bridge   # first line confirms e2e=on/off; then watch it replicate
```

Decoded files appear under `./data/vault/`; `senya-notes` is already pointed there
in the root `docker-compose.yaml`.

## How sync flows

- Peers sharing the same `group` (`"vault"`) replicate with each other.
- The **couchdb** peer talks to `obsidian-couchdb:5984` over the internal docker
  network (no need for the published `:5984`).
- The **storage** peer writes decoded files to `/app/data/vault` (→ `./data/vault`
  on the host) and, via `useChokidar`, notices local edits and pushes them back to
  CouchDB → all your devices.

## Caveats

- **Two writers, one folder.** Both this bridge and `senya-notes` write the same
  files — fine and intended, but don't edit the *same note* in two places at the
  same instant. LiveSync resolves collisions by leaving `*.conflicted-*.md` files,
  cleanable in any client.
- **First sync.** Give it a moment on first boot to pull the whole vault down.
- **Format upgrades.** When the LiveSync plugin bumps its storage format, rebuild
  this image (`--build-arg BRIDGE_REF=<new-tag>`), not `senya-notes`.

## Layout

| Path | What | In git? |
|------|------|---------|
| `Dockerfile` | clones + builds upstream bridge | ✅ |
| `render-config.ts` | generates `config.json` from env on boot | ✅ |
| `entrypoint.sh` | render config → run bridge | ✅ |
| `data/` | bridge state + `data/vault/` output files | ❌ git-ignored |
| `dat/config.json` | generated at runtime inside the container | n/a (not on host) |
