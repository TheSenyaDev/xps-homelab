# SenyaDaily

A self-contained **daily-notes** app for the senya homelab: **Flask + SQLite**
backend, vanilla-JS frontend, single **Docker** image with a mountable `/data`
volume. Each day holds a free-text note plus a value for any number of
**user-defined trackers**, and a month **calendar** ties it all together.

## Features

- **Day view** — pick any date (‹ / › / date picker / Today), write a free-text
  note, and fill in your trackers. Everything autosaves as you type.
- **Extensible trackers** — log whatever you want; add/remove them from the
  ⚙ Trackers panel. Four field types out of the box:
  - **Number** (e.g. pushups, water) with optional unit and +/− steppers
  - **Text** (e.g. food eaten, journal snippets)
  - **Checkbox** (e.g. went to the gym)
  - **Rating** 1–5 (e.g. mood)
- **Calendar view** — month grid showing which days have a note (dot) and how
  many trackers were filled (count); click a day to jump to it.
- **Obsidian export** — every change writes `/data/notes/YYYY-MM-DD.md`: scalar
  trackers (number/rating/check) as YAML frontmatter, text trackers + the note
  in the body. Empty days delete their file. Drop the folder into a vault as
  your daily notes.

Seeded on first run with example trackers (Pushups, Water, Food, Workout, Mood)
so every field type is visible immediately — delete or edit them freely.

## Adding a new field *type*

The type set lives in one place. To add e.g. a `duration` type:

1. add it to `TYPES` in `app.py` and teach `build_markdown()` how to render it;
2. add an input branch in `static/app.js` → `trackerInput()`;
3. add the `<option>` in `static/index.html`.

## Run with Docker Compose

```bash
docker compose up --build -d
```

Then open <http://localhost:8001>. Data lives in `./data/` on the host
(`daily.db` + `notes/`).

## Run locally without Docker

```bash
pip install -r requirements.txt
DB_PATH=./data/daily.db python app.py   # http://localhost:8001
```

## API

| Method | Path                  | Body                                                   |
|--------|-----------------------|--------------------------------------------------------|
| GET    | `/api/trackers`       | — (`?archived=1` to include archived)                  |
| POST   | `/api/trackers`       | `{ "name", "type?", "unit?", "icon?", "color?" }`      |
| PATCH  | `/api/trackers/:id`   | any of `name,type,unit,icon,color,position,archived`   |
| DELETE | `/api/trackers/:id`   | — (cascades to that tracker's entries)                 |
| GET    | `/api/days/:date`     | — → `{ date, note, entries: {tracker_id: value} }`     |
| PUT    | `/api/days/:date`     | `{ "note?", "entries?": {tracker_id: value} }`         |
| GET    | `/api/calendar`       | `?year=&month=` → per-day `{note, entries}` summary    |

`:date` is `YYYY-MM-DD`. An empty entry value deletes that entry; an empty note
deletes the note.

## Config

| Env var     | Default          | Purpose                                   |
|-------------|------------------|-------------------------------------------|
| `DB_PATH`   | `/data/daily.db` | SQLite database file                      |
| `NOTES_DIR` | `/data/notes`    | Folder of per-day Obsidian markdown files |
