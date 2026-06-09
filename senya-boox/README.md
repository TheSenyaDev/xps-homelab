# SenyaBoox

A simple **PDF reader** for the notes your Onyx Boox exports over WebDAV, served
on the homelab at **`:8004`**. Browse the notes as a file tree, click one, and
it renders inline in the browser's built-in PDF viewer.

```
Boox ──WebDAV──► ./webdav/data/*.pdf  ◄──(read-only)── SenyaBoox (:8004)
```

SenyaBoox is deliberately *dumb*: it only **reads** `.pdf` files from a mounted
folder — the same `./webdav/data` the [`webdav`](../webdav/README.md) service
writes to. It never modifies anything (the volume is mounted `:ro`), so it can't
touch what your Boox synced.

## Features

- **File tree** sidebar (folders + PDFs), with a filter box and file sizes.
- Click a note → **inline PDF view**; **↗ Open** in a new tab or **↓ Download**.
- **⟳ Refresh** to pick up notes that synced since you loaded the page.
- Every request is **sandboxed** to inside the notes root — no path escapes, and
  only `.pdf` files are listed or served.

## Run

Part of the root stack (build the `webdav` + `senya-boox` pair):

```bash
docker compose up -d --build webdav senya-boox
```

Then open `http://192.168.2.100:8004` (LAN) or `http://100.121.230.17:8004`
(Tailscale).

## Config

| Env var     | Default  | Meaning                                              |
|-------------|----------|------------------------------------------------------|
| `NOTES_DIR` | `/notes` | Folder scanned for PDFs (bind-mounted `./webdav/data`). |

## How it fits together

The Boox syncs its PDF exports to the WebDAV share; the files land in
`./webdav/data` on the host. SenyaBoox mounts that exact folder read-only and
serves them. To view a new note: sync on the Boox, then hit **⟳** here.
