# SenyaNotes

A simple **plain-markdown reader / editor** for your Obsidian vault, served on the
homelab at **`:8003`**. Browse the vault as a file tree, open a note, edit it with
**live preview**, and changes sync back to every device.

```
phone / desktop Obsidian ──► obsidian-couchdb ──livesync-bridge──► ./data/vault/*.md ◄── SenyaNotes (:8003)
```

SenyaNotes is deliberately *dumb*: it only reads and writes `.md` files in a
mounted folder. It knows nothing about Obsidian's chunked/encrypted sync format —
that decoding is the [`livesync-bridge`](../livesync-bridge/README.md) sidecar's
job. So this app requires the bridge to be running and pointed at the same folder
(`./livesync-bridge/data/vault`, already wired in the root compose).

## Features

- **File tree** sidebar with folders, filter box, and remembered expand state.
- **Edit / Split / Preview** modes; the preview is a tiny built-in markdown
  renderer (no CDN — works fully offline), covering headings, bold/italic, code,
  links, images, lists + task lists, blockquotes, tables, and rules.
- **Autosave** 0.8s after you stop typing (also `Ctrl/Cmd-S`, and on tab close).
  Saves are atomic (`tmp` + `os.replace`) so the bridge never reads a half-written
  file.
- **New / delete** notes; deletes propagate to the synced vault too.
- Every request is **sandboxed** to inside the vault root — no path escapes.

## Run

It's part of the root stack:

```bash
docker compose up -d --build livesync-bridge senya-notes
```

Then open `http://192.168.2.100:8003` (LAN) or `http://100.121.230.17:8003`
(Tailscale).

## Config

| Env | Default | Meaning |
|-----|---------|---------|
| `VAULT_DIR` | `/vault` | folder of `.md` files to browse/edit (the bridge's output, bind-mounted) |

## Caveats

- Needs `livesync-bridge` up first — without it, `./livesync-bridge/data/vault` is
  empty and the tree shows nothing.
- Don't edit the *same note* here and in another Obsidian client simultaneously;
  LiveSync will resolve the clash with a `*.conflicted-*.md` file.

## Layout

| Path | What |
|------|------|
| `app.py` | Flask API: tree / read / write / new / delete, path-sandboxed |
| `static/index.html` · `style.css` | UI |
| `static/markdown.js` | dependency-free markdown→HTML renderer (preview) |
| `static/app.js` | tree, editor, autosave, modes |
