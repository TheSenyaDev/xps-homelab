# SenyaTasks

A small self-contained task tracker for the senya homelab: **Flask + SQLite** backend, vanilla-JS frontend,
tasks grouped by **category**, packaged into a single **Docker** image with a
mountable volume for the database.

## Features

- Create / edit (click a title) / complete / delete tasks
- **Nested categories & subcategories** (a category can have a parent); pick a
  parent in the sidebar form. Deleting a parent cascade-removes its
  subcategories and orphans affected tasks to "Uncategorized".
- Per-task priority (low / medium / high)
- Filter by All / Active / Done; selecting a category includes its subcategories
- Data persisted in a SQLite file under `/data` (Docker volume)
- **Live Obsidian export:** every change rewrites `/data/Tasks.md` (atomically)
  with YAML frontmatter, nested headings, and `- [ ]` / `- [x]` checkboxes.

## Obsidian sync

`Tasks.md` is written into the same volume as the DB, so on the host it's at
`./data/Tasks.md`. To pull it into a vault, either symlink it in:

```bash
ln -s "$PWD/data/Tasks.md" /path/to/Vault/Tasks.md
```

or point the app straight at your vault by setting `MARKDOWN_PATH` (mount the
vault into the container and set e.g. `MARKDOWN_PATH=/vault/Tasks.md`). The file
is regenerated from the DB on every write, so edit tasks in the app, not the
file.

## Run with Docker Compose

```bash
docker compose up --build -d
```

Then open <http://localhost:8000>. The database lives in `./data/tasks.db` on the host.

## Run with plain Docker

```bash
docker build -t senyatasks .
docker run -d --name senyatasks -p 8000:8000 -v "$PWD/data:/data" senyatasks
```

## Run locally without Docker

```bash
pip install -r requirements.txt
DB_PATH=./data/tasks.db python app.py   # http://localhost:8000
```

## API

| Method | Path                   | Body                                       |
|--------|------------------------|--------------------------------------------|
| GET    | `/api/categories`      | —                                          |
| POST   | `/api/categories`      | `{ "name", "color?", "parent_id?" }`        |
| DELETE | `/api/categories/:id`  | — (cascades to subcategories; tasks → uncategorized) |
| GET    | `/api/tasks`           | —                                          |
| POST   | `/api/tasks`           | `{ "title", "priority?", "category_id?" }` |
| PATCH  | `/api/tasks/:id`       | any of `title`, `done`, `priority`, `category_id` |
| DELETE | `/api/tasks/:id`       | —                                          |

## Config

| Env var         | Default          | Purpose                          |
|-----------------|------------------|----------------------------------|
| `DB_PATH`       | `/data/tasks.db` | SQLite database file             |
| `MARKDOWN_PATH` | `/data/Tasks.md` | Auto-generated Obsidian markdown |
