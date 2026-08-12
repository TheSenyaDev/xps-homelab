# SenyaTasks

A small self-contained task tracker for the senya homelab: **Flask + SQLite** backend, vanilla-JS
frontend, tasks grouped by **category**, packaged into a single **Docker** image with a mountable
volume for the database.

Directory / image / container are `senya-tasks` (matching `senya-daily`, `senya-notes`, …); the
app still presents itself as **SenyaTasks**.

| | |
|---|---|
| [Features](#features) · [UI notes](#ui-notes) | what it does |
| [Data model](#data-model) · [Extending the schema](#extending-the-schema) | tables, migrations, adding a field |
| [CalDAV sync](#caldav-sync-apple-reminders-davx5-thunderbird) → **[CALDAV.md](CALDAV.md)** | tasks in Apple Reminders |
| [Obsidian sync](#obsidian-sync) · [Export](#export-on-demand) · [Import](#import-from-obsidian) | markdown in and out |
| [Run](#run-with-docker-compose) · [API](#api) · [Config](#config) | operating it |

## Features

- Create / rename (click a title) / complete / delete tasks
- **Four statuses** — `todo · doing · blocked · done` — plus notes, due dates and tags
- **Nested categories & subcategories** (a category can have a parent). Deleting a parent
  cascade-removes its subcategories and orphans affected tasks to "Uncategorized".
- Per-task priority (low / medium / high), shown as a coloured edge on each row
- Filter by status, category subtree, tag or free text; sort by manual order, date, due, priority
  or title
- Data persisted in a SQLite file under `/data` (Docker volume)
- **Live Obsidian export:** every change rewrites `/data/Tasks.md` (atomically) with YAML
  frontmatter, nested headings and `- [ ]` / `- [x]` checkboxes
- **On-demand export** (`↓ md`) of exactly what you're looking at, and **import** (`↑ md`) that
  parses pasted Obsidian markdown into a reviewable, editable list before anything is saved
- **Calendar view** — a month grid of tasks by due date, sharing the list's filters
- **Two-way CalDAV sync** so tasks live in Apple Reminders, optionally one Reminders list per
  category ([CALDAV.md](CALDAV.md))

## UI notes

The list is deliberately dense: rows are hairline-separated instead of cards, ~28 px tall, with
status/tag/due shown as small chips only when they carry information (a `todo` chip would be noise
on every row, so it's hidden). Everything secondary — notes, due date, category, tags, timestamps —
lives in an inline detail panel opened with the `▾` button, so the scannable list stays one line
per task.

Three CSS variables at the top of [`static/style.css`](static/style.css) drive the density:

| Variable | Default | Effect                          |
|----------|---------|---------------------------------|
| `--row`  | `30px`  | task and category row height    |
| `--fs`   | `13px`  | body text size                  |
| `--gap`  | `8px`   | spacing between row elements    |

There are two views, switched with the `☰ | ▦` toggle in the toolbar. The **calendar** is a month
grid of tasks by due date; it shows exactly what the list would show (same category, status, tag
and search filters), undated tasks get their own strip beneath it, and clicking a chip jumps back
to the list with that task open.

Keyboard: `/` search · `n` new task · `c` list ⇄ calendar · `←`/`→` change month · `\` toggle
sidebar · `Esc` close a detail panel or dialog.
Selected category, filter, sort, tag, view and collapsed subtrees persist in `localStorage`.

## Data model

`PRAGMA user_version` tracks the schema version (currently **6**). Migrations M4–M6 add the
CalDAV sync tables — see [CALDAV.md](CALDAV.md#schema).

### `tasks`

| Column         | Type    | Notes                                                          |
|----------------|---------|----------------------------------------------------------------|
| `id`           | INTEGER | primary key                                                    |
| `title`        | TEXT    | required, trimmed, max 500 chars                               |
| `notes`        | TEXT    | free-form body, `''` when empty                                |
| `status`       | TEXT    | `todo` \| `doing` \| `blocked` \| `done` (CHECK-constrained)   |
| `priority`     | TEXT    | `high` \| `medium` \| `low` (CHECK-constrained)                |
| `category_id`  | INTEGER | → `categories.id`, `ON DELETE SET NULL`                        |
| `due_date`     | TEXT    | `YYYY-MM-DD`, or NULL                                          |
| `position`     | INTEGER | manual ordering; assigned on insert, rewritten by `/reorder`   |
| `created_at`   | TEXT    | UTC, set by SQLite                                             |
| `updated_at`   | TEXT    | bumped by a trigger on **every** update                        |
| `completed_at` | TEXT    | set/cleared by a trigger as `status` enters/leaves `done`      |

The audit columns are maintained by triggers rather than by the app, so they stay correct even if
you edit the DB from the `sqlite3` CLI or a script.

`done` is **not** a column any more — it's derived. Every task in an API response still carries
`"done": true|false` mirroring `status == 'done'`, and writes may send `done` instead of `status`,
so existing clients and plain checkboxes keep working.

### `categories`

`id`, `name`, `color`, `parent_id` (self-referencing, `ON DELETE CASCADE`), `position`,
`created_at`. `UNIQUE(parent_id, name)` — the same name may exist under different parents.

### `tags` and `task_tags`

Tags are cross-cutting labels that don't fit the single-parent category tree. `tags` holds
`id`, `name` (unique, lowercased, spaces → `-`), `color`; `task_tags` is the join table, cascading
on both sides. Posting a tag name that doesn't exist creates it.

Indexes: `tasks(category_id)`, `tasks(status)`, `tasks(due_date)`, `task_tags(tag_id)`.

## Extending the schema

Migrations live in [`app.py`](app.py) as a list of SQL scripts. `BASELINE` is the original v0
schema; each entry in `MIGRATIONS` is one numbered step, applied in order and recorded in
`PRAGMA user_version`. A brand-new database is created at the baseline and then migrated up, so the
upgrade path is exercised on every fresh install rather than only against the one old database in
production — a broken migration shows up immediately.

To add a field:

1. **Append** a migration to `MIGRATIONS` (never edit a released one — databases that already ran
   it won't run it again):

   ```python
   M7 = "ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER;"
   MIGRATIONS = [M1, M2, M3, M4, M5, M6, M7]
   ```

   SQLite can't add a CHECK constraint to an existing table; if you need one, rebuild the table
   the way `M1` does (create `tasks_new`, `INSERT … SELECT`, drop, rename).

2. **Add one line** to `TASK_FIELDS`, mapping the field to a validator:

   ```python
   TASK_FIELDS = {
       ...,
       "estimate_minutes": v_int("estimate_minutes"),
   }
   ```

   That single table drives both `POST` and `PATCH`, so the field is now creatable, updatable and
   validated. Validators normalise the value or raise `ApiError(msg, status)`.

3. Optionally surface it in `build_markdown()` (export), `parse_task_text()` (import) and the
   frontend's `taskDetail()`. Skipping these is fine — the field just won't round-trip through
   markdown.

New status or priority values go in the `STATUSES` / `PRIORITIES` tuples at the top of `app.py`
**and** in a migration that widens the CHECK constraint. `GET /api/meta` serves those vocabularies
to the frontend, which builds its filter buttons and dropdowns from them — no hardcoded lists in
the UI.

## CalDAV sync (Apple Reminders, DAVx5, Thunderbird…)

Two-way sync between the `tasks` table and `VTODO`s in a CalDAV calendar. Point
it at the collection your phone's account uses and tasks appear in **Apple
Reminders** — they read `VTODO`, while the Calendar app reads `VEVENT`, which is
why tasks land in Reminders and not in your calendar grid.

Configure it in the app: **⚙** in the top bar → URL, username, password →
**Test connection** → **Save**. Nothing is written to `.env` and no redeploy is
needed; settings live in the database and override the `CALDAV_*` env defaults.

Two modes:

- **one list for everything** — every task in a single collection. Categories
  stay a senya-tasks concept.
- **one list per category** — a Reminders list per category, created and named
  for you, with an `Inbox` for uncategorised tasks. Moving a reminder between
  lists on your phone changes its category here.

Status is visible at a glance from the **⇄ chip** beside the toolbar buttons:
green with the time of the last sync, amber when overdue, grey when paused.

📖 **[CALDAV.md](CALDAV.md)** — field mapping, the consistency model, how moves
and deletes are reconciled, schema, API, troubleshooting.

## Obsidian sync

`Tasks.md` is written into the same volume as the DB, so on the host it's at `./data/Tasks.md`.
To pull it into a vault, either symlink it in:

```bash
ln -s "$PWD/data/Tasks.md" /path/to/Vault/Tasks.md
```

or point the app straight at your vault by setting `MARKDOWN_PATH` (mount the vault into the
container and set e.g. `MARKDOWN_PATH=/vault/Tasks.md`). The file is regenerated from the DB on
every write, so edit tasks in the app, not the file.

Emoji follow the [Obsidian Tasks](https://publish.obsidian.md/tasks/) plugin syntax so the export
stays queryable there:

```markdown
## Work

- [/] Rotate the Tailscale auth keys #infra #security `doing` ⏫ 📅 2026-08-01
- [ ] Write up the Grafana dashboard notes #docs 🔼 📅 2026-08-05
    Cover the RAPL power panel and the GPU temp series.
- [x] Order new drill bits #errand 🔽 ✅ 2026-08-05
```

Checkbox characters carry the status: `[ ]` todo, `[/]` doing, `[!]` blocked, `[x]` done.

## Export on demand

`Tasks.md` is rewritten on every change, but the **`↓ md`** button in the top bar downloads the
current view as a dated `.md` file — whatever category, status filter, tag and search box are
active. Categories that contributed no tasks are pruned, so a one-category export isn't padded
with empty headings.

Under the hood that's `GET /api/export`, which accepts every `GET /api/tasks` filter plus
`?ids=1,2,3` and `?download=1`:

```bash
curl 'localhost:8000/api/export?status=done'                  # completed work
curl 'localhost:8000/api/export?category_id=3&download=1' -OJ # one category, as a file
```

The UI passes explicit `ids` because its search box and tag chips filter in the browser — the id
list is the only faithful description of what's on screen.

## Import from Obsidian

**`↑ md`** opens a two-step importer: paste markdown, hit **Parse**, then review a table of
proposed tasks before anything is written.

The parser is deliberately forgiving, because people paste whole notes rather than clean lists:

| In the markdown                              | Becomes                                          |
|----------------------------------------------|--------------------------------------------------|
| `## Work`, `### Garage`                      | category, nested by heading level                 |
| `- [ ]` `[/]` `[!]` `[x]`                    | status todo / doing / blocked / done              |
| `🔺` `⏫` `🔼` `🔽` `⏬`                        | priority (highest and lowest fold into high/low)  |
| `📅` `📆` `🗓` + `YYYY-MM-DD`                  | due date                                          |
| `✅ YYYY-MM-DD`                               | completion date, preserved rather than re-stamped |
| `#tag`                                       | tags (lowercased, spaces → `-`)                   |
| indented lines under a task                  | notes                                             |
| `- plain bullet`, `1. numbered`              | a candidate task, **unticked**, flagged           |

Ignored outright: YAML frontmatter, prose paragraphs, `>` callouts and quotes, and a lone `#` H1
before the first task (that's the note's title, not a category — otherwise every round-trip nests
everything one level deeper).

Obsidian Tasks fields with no equivalent here — `🔁` recurrence, `🛫` start, `⏳` scheduled, `➕`
created, `🆔`/`⛔` dependencies — are stripped from the title and reported as a warning on that
row, so you can see what was dropped instead of finding it glued into a task name.

### The review step

Every row is editable — title, status, priority, due date, tags, and a slash-separated category
path (`Home / Garage`) that's created on import if it doesn't exist. Rows carrying a warning are
tinted; duplicates of tasks you already have are tinted red and called out by name. Plain bullets
arrive unticked, so junk needs an explicit opt-in rather than an opt-out. **Select all**, **None**
and **Only clean** (everything without a warning) handle the bulk cases.

Guarantees worth knowing:

- **Preview writes nothing.** `POST /api/import/preview` only parses; the database is untouched
  until you press Import.
- **Your edits win.** The reviewed items are what get posted, not the original text.
- **Same validation as any other write.** Committed items go through the same `TASK_FIELDS`
  validators as `POST /api/tasks` — the import path has no shortcut into the database.
- **All or nothing.** One bad row aborts the whole batch and rolls back, so a partial import can't
  leave half a note behind.

### Round trip

Export → import is lossless for everything the schema holds: status, priority, due date, tags,
notes, completion dates and category placement all survive, and re-importing your own export
produces no warnings. It does create *duplicates* if the tasks are still there — that's what the
duplicate flagging in the review step is for.

```bash
# import a note from the command line
curl -X POST localhost:8000/api/import/preview -H 'Content-Type: application/json' \
     -d '{"markdown":"## Work\n- [ ] ship it ⏫ 📅 2026-09-01"}'
# feed the reviewed items straight back
curl -X POST localhost:8000/api/import/commit -H 'Content-Type: application/json' \
     -d '{"items":[{"title":"ship it","priority":"high","due_date":"2026-09-01",
                    "category_path":["Work"],"tags":["ship"]}]}'
```

## Deploying the rename (one time)

This app used to live in `senyatasks/` with an image and container of the same name. The database
is gitignored (`*.db`), so pulling the rename onto the homelab host moves the tracked files but
leaves the old data directory behind — move it across before starting, or the app comes up with an
empty database:

```bash
cd ~/xps-homelab
git pull
mv senyatasks/data/* senya-tasks/data/ 2>/dev/null && rmdir senyatasks/data senyatasks
docker compose up -d --build --remove-orphans senya-tasks   # --remove-orphans drops the old container
docker image rm senyatasks:latest                            # optional cleanup
```

The first start migrates the database in place (v0 → v3); it's worth taking a copy of
`data/tasks.db` first.

## Run with Docker Compose

```bash
docker compose up --build -d
```

Then open <http://localhost:8000>. The database lives in `./data/tasks.db` on the host.

## Run with plain Docker

```bash
docker build -t senya-tasks .
docker run -d --name senya-tasks -p 8000:8000 -v "$PWD/data:/data" senya-tasks
```

## Run locally without Docker

```bash
pip install -r requirements.txt
DB_PATH=./data/tasks.db MARKDOWN_PATH=./data/Tasks.md python app.py   # http://localhost:8000
```

## Tests

A pytest suite in [`tests/`](tests) covers the API (tasks, categories, tags, settings), the
migration runner, Obsidian markdown export/import, and the CalDAV iCalendar and sync-consistency
logic (against an in-memory fake server, no real CalDAV needed). It runs against its own throwaway
database — `./data` is never touched, and `tests/` isn't shipped in the Docker image.

```bash
pip install -r requirements-dev.txt
pytest
```

## API

All bodies are JSON. Errors come back as `{"error": "..."}` with a 4xx status.

| Method | Path                    | Body / query                                                        |
|--------|-------------------------|---------------------------------------------------------------------|
| GET    | `/api/meta`             | schema version, status/priority vocabularies, per-status counts      |
| GET    | `/api/categories`       | —                                                                    |
| POST   | `/api/categories`       | `{ name, color?, parent_id? }`                                       |
| PATCH  | `/api/categories/:id`   | any of `name`, `color`, `parent_id`, `position`                      |
| DELETE | `/api/categories/:id`   | — (cascades to subcategories; their tasks → uncategorized)           |
| GET    | `/api/tags`             | — (each tag carries a `task_count`)                                  |
| PATCH  | `/api/tags/:id`         | `name` and/or `color`                                                |
| DELETE | `/api/tags/:id`         | — (removes the label everywhere; tasks are untouched)                |
| GET    | `/api/tasks`            | filters: `?status= ?priority= ?category_id= ?tag= ?q= ?due_before= ?ids=` |
| POST   | `/api/tasks`            | `{ title, notes?, status?, priority?, category_id?, due_date?, position?, tags? }` |
| PATCH  | `/api/tasks/:id`        | any subset of the same fields (plus `done` as a `status` shortcut)   |
| POST   | `/api/tasks/reorder`    | `{ "ids": [3, 1, 2] }` — rewrites `position` in the order given      |
| DELETE | `/api/tasks/:id`        | —                                                                    |
| GET    | `/api/export`           | markdown; same filters as `/api/tasks`, plus `?download=1`           |
| POST   | `/api/import/preview`   | `{ markdown, default_status? }` → proposed tasks + warnings, no writes |
| POST   | `/api/import/commit`    | `{ items: [...], create_categories? }` → inserts the reviewed items   |
| GET    | `/api/caldav`           | sync status — mode, last run, mapped count, collections ([CALDAV.md](CALDAV.md#api)) |
| PUT    | `/api/caldav/config`    | `{ url, user, password?, auth?, mode?, interval?, enabled? }`         |
| POST   | `/api/caldav/test`      | check settings against the server without saving them                 |
| POST   | `/api/caldav/sync`      | run a sync pass now                                                   |

`?category_id=none` selects uncategorized tasks; `?q=` matches title **and** notes. `tags` on a
write **replaces** the task's whole tag set. Import items accept every task field plus
`category_path: ["Home", "Garage"]` and an `include` flag (items with `include: false` are skipped).

```bash
# everything overdue, highest priority first
curl 'http://localhost:8000/api/tasks?due_before=2026-08-05&priority=high'

# park a task and label it
curl -X PATCH localhost:8000/api/tasks/7 -H 'Content-Type: application/json' \
     -d '{"status":"blocked","tags":["waiting","infra"]}'
```

## Config

| Env var         | Default          | Purpose                          |
|-----------------|------------------|----------------------------------|
| `DB_PATH`       | `/data/tasks.db` | SQLite database file             |
| `MARKDOWN_PATH` | `/data/Tasks.md` | Auto-generated Obsidian markdown |
