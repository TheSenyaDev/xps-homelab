"""
SenyaDaily — a daily-notes web app for the senya homelab.

Flask + SQLite + vanilla JS, packaged as a single Docker image with a mountable
/data volume. Each day has a free-text note plus a value for any number of
user-defined *trackers* (number / text / check / rating), so what you log is
fully extensible from the UI — add a tracker, it shows up on every day.

Every change also writes an Obsidian-friendly markdown file per day under
/data/notes/YYYY-MM-DD.md (scalar trackers in frontmatter, text trackers and the
note in the body), so the whole journal drops straight into a vault.
"""

import os
import re
import sqlite3
from datetime import date, datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory

DB_PATH = os.environ.get("DB_PATH", "/data/daily.db")
# Folder of per-day markdown files (one file per day), sibling to the DB by
# default so both live in the same mounted volume.
NOTES_DIR = os.environ.get(
    "NOTES_DIR", os.path.join(os.path.dirname(DB_PATH) or ".", "notes")
)
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# The set of tracker field types the app understands. Adding a new type is a
# localized change: add it here, teach build_markdown() how to render it, and add
# an input renderer in the frontend (app.js `trackerInput`).
TYPES = ("number", "text", "check", "rating")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

app = Flask(__name__, static_folder=None)

SCHEMA = """
CREATE TABLE IF NOT EXISTS trackers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'number',
    unit       TEXT NOT NULL DEFAULT '',
    icon       TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '#6366f1',
    position   INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    calendar   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
    day        TEXT PRIMARY KEY,
    text       TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One value per (day, tracker). Value is stored as TEXT and interpreted
-- according to the tracker's type.
CREATE TABLE IF NOT EXISTS entries (
    day        TEXT NOT NULL,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (day, tracker_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(day);
"""

# Seeded on first run so the app isn't empty and demonstrates every field type.
DEFAULT_TRACKERS = [
    ("Pushups", "number", "reps", "💪", "#ef4444"),
    ("Water", "number", "glasses", "💧", "#38bdf8"),
    ("Food", "text", "", "🍔", "#f59e0b"),
    ("Workout", "check", "", "🏋️", "#10b981"),
    ("Mood", "rating", "", "🙂", "#a78bfa"),
]


def connect(path=DB_PATH):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = connect()
    conn.executescript(SCHEMA)
    # Migrate older DBs that predate the per-tracker `calendar` flag.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(trackers)").fetchall()}
    if "calendar" not in cols:
        conn.execute("ALTER TABLE trackers ADD COLUMN calendar INTEGER NOT NULL DEFAULT 1")
    if conn.execute("SELECT COUNT(*) FROM trackers").fetchone()[0] == 0:
        for pos, (name, typ, unit, icon, color) in enumerate(DEFAULT_TRACKERS):
            conn.execute(
                "INSERT INTO trackers (name, type, unit, icon, color, position) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (name, typ, unit, icon, color, pos),
            )
    conn.commit()
    conn.close()


# ----- helpers -----

def valid_date(s):
    if not isinstance(s, str) or not DATE_RE.match(s):
        return False
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return s or "field"


def tracker_dict(row):
    return dict(row)


# ----- markdown export (one file per day, Obsidian-friendly) -----

def md_path(day):
    return os.path.join(NOTES_DIR, f"{day}.md")


def yaml_scalar(typ, value):
    """Render a tracker value as a YAML frontmatter scalar."""
    if typ == "check":
        return "true" if value in ("1", "true", "True") else "false"
    if typ in ("number", "rating"):
        return value  # already a bare number
    # text: quote and escape for safety
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_markdown(conn, day):
    note = conn.execute("SELECT text FROM notes WHERE day = ?", (day,)).fetchone()
    note_text = (note["text"] if note else "").strip()

    rows = conn.execute(
        """
        SELECT t.name, t.type, t.unit, t.icon, e.value
          FROM entries e JOIN trackers t ON t.id = e.tracker_id
         WHERE e.day = ?
         ORDER BY t.position, t.name
        """,
        (day,),
    ).fetchall()

    scalars = [r for r in rows if r["type"] in ("number", "rating", "check")]
    texts = [r for r in rows if r["type"] == "text" and r["value"].strip()]

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    used = {}
    lines = ["---", f"date: {day}", f"updated: {now} UTC"]
    for r in scalars:
        key = slugify(r["name"])
        # guard against two trackers slugifying to the same key
        if key in used:
            key = f"{key}_{used[key]}"
        used[key] = used.get(key, 0) + 1
        lines.append(f"{key}: {yaml_scalar(r['type'], r['value'])}")
    lines += ["---", "", f"# 🗓️ {day}", ""]

    if note_text:
        lines += [note_text, ""]

    for r in texts:
        head = f"## {r['icon'] + ' ' if r['icon'] else ''}{r['name']}"
        lines += [head, "", r["value"].strip(), ""]

    return "\n".join(lines).rstrip() + "\n"


def day_has_data(conn, day):
    note = conn.execute("SELECT text FROM notes WHERE day = ?", (day,)).fetchone()
    if note and note["text"].strip():
        return True
    n = conn.execute("SELECT COUNT(*) FROM entries WHERE day = ?", (day,)).fetchone()[0]
    return n > 0


def sync_day(day):
    """Rewrite (or delete) the per-day markdown file to mirror the DB."""
    conn = get_db()
    os.makedirs(NOTES_DIR, exist_ok=True)
    path = md_path(day)
    if not day_has_data(conn, day):
        if os.path.exists(path):
            os.remove(path)
        return
    content = build_markdown(conn, day)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)  # atomic so Obsidian never sees a partial file


# ----- API: trackers -----

@app.get("/api/trackers")
def list_trackers():
    include_archived = request.args.get("archived") == "1"
    sql = "SELECT * FROM trackers"
    if not include_archived:
        sql += " WHERE archived = 0"
    sql += " ORDER BY position, id"
    rows = get_db().execute(sql).fetchall()
    return jsonify([tracker_dict(r) for r in rows])


@app.post("/api/trackers")
def create_tracker():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    typ = data.get("type") if data.get("type") in TYPES else "number"
    unit = (data.get("unit") or "").strip()
    icon = (data.get("icon") or "").strip()
    color = (data.get("color") or "#6366f1").strip()
    calendar = 0 if data.get("calendar") is False else 1  # default: shown on calendar
    db = get_db()
    nextpos = db.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM trackers").fetchone()[0]
    cur = db.execute(
        "INSERT INTO trackers (name, type, unit, icon, color, position, calendar) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (name, typ, unit, icon, color, nextpos, calendar),
    )
    db.commit()
    row = db.execute("SELECT * FROM trackers WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(tracker_dict(row)), 201


@app.patch("/api/trackers/<int:tid>")
def update_tracker(tid):
    data = request.get_json(force=True) or {}
    fields, values = [], []
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name cannot be empty"}), 400
        fields.append("name = ?"); values.append(name)
    if "type" in data and data["type"] in TYPES:
        fields.append("type = ?"); values.append(data["type"])
    if "unit" in data:
        fields.append("unit = ?"); values.append((data.get("unit") or "").strip())
    if "icon" in data:
        fields.append("icon = ?"); values.append((data.get("icon") or "").strip())
    if "color" in data:
        fields.append("color = ?"); values.append((data.get("color") or "#6366f1").strip())
    if "position" in data:
        fields.append("position = ?"); values.append(int(data["position"]))
    if "archived" in data:
        fields.append("archived = ?"); values.append(1 if data["archived"] else 0)
    if "calendar" in data:
        fields.append("calendar = ?"); values.append(1 if data["calendar"] else 0)
    if not fields:
        return jsonify({"error": "nothing to update"}), 400
    values.append(tid)
    db = get_db()
    db.execute(f"UPDATE trackers SET {', '.join(fields)} WHERE id = ?", values)
    db.commit()
    row = db.execute("SELECT * FROM trackers WHERE id = ?", (tid,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(tracker_dict(row))


@app.delete("/api/trackers/<int:tid>")
def delete_tracker(tid):
    db = get_db()
    # Days whose markdown must be regenerated after the tracker's entries vanish.
    affected = [r["day"] for r in db.execute(
        "SELECT DISTINCT day FROM entries WHERE tracker_id = ?", (tid,)
    ).fetchall()]
    db.execute("DELETE FROM trackers WHERE id = ?", (tid,))  # cascades to entries
    db.commit()
    for day in affected:
        sync_day(day)
    return "", 204


# ----- API: days -----

def load_day(conn, day):
    note = conn.execute("SELECT text FROM notes WHERE day = ?", (day,)).fetchone()
    entries = conn.execute(
        "SELECT tracker_id, value FROM entries WHERE day = ?", (day,)
    ).fetchall()
    return {
        "date": day,
        "note": note["text"] if note else "",
        "entries": {str(r["tracker_id"]): r["value"] for r in entries},
    }


@app.get("/api/days/<day>")
def get_day(day):
    if not valid_date(day):
        return jsonify({"error": "bad date"}), 400
    return jsonify(load_day(get_db(), day))


@app.put("/api/days/<day>")
def put_day(day):
    if not valid_date(day):
        return jsonify({"error": "bad date"}), 400
    data = request.get_json(force=True) or {}
    db = get_db()

    if "note" in data:
        text = data.get("note") or ""
        if text.strip():
            db.execute(
                "INSERT INTO notes (day, text, updated_at) VALUES (?, ?, datetime('now')) "
                "ON CONFLICT(day) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
                (day, text),
            )
        else:
            db.execute("DELETE FROM notes WHERE day = ?", (day,))

    if "entries" in data and isinstance(data["entries"], dict):
        valid_ids = {r["id"] for r in db.execute("SELECT id FROM trackers").fetchall()}
        for tid_str, value in data["entries"].items():
            try:
                tid = int(tid_str)
            except (TypeError, ValueError):
                continue
            sval = "" if value is None else str(value).strip()
            if sval == "":
                db.execute(
                    "DELETE FROM entries WHERE day = ? AND tracker_id = ?", (day, tid)
                )
            elif tid in valid_ids:  # skip unknown trackers rather than FK-crash
                db.execute(
                    "INSERT INTO entries (day, tracker_id, value, updated_at) "
                    "VALUES (?, ?, ?, datetime('now')) "
                    "ON CONFLICT(day, tracker_id) DO UPDATE SET "
                    "value = excluded.value, updated_at = excluded.updated_at",
                    (day, tid, sval),
                )
    db.commit()
    sync_day(day)
    return jsonify(load_day(db, day))


@app.get("/api/calendar")
def calendar():
    """Per-day summary for a month: note flag + which trackers were logged.

    Each day is {note: bool, trackers: [tracker_id, …], entries: count}, so the
    calendar can show the icons of the trackers completed that day.
    Query: ?year=YYYY&month=M  (defaults to the current month).
    """
    today = date.today()
    try:
        year = int(request.args.get("year", today.year))
        month = int(request.args.get("month", today.month))
    except ValueError:
        return jsonify({"error": "bad year/month"}), 400
    if not (1 <= month <= 12):
        return jsonify({"error": "bad month"}), 400

    start = f"{year:04d}-{month:02d}-01"
    end = f"{year:04d}-{month:02d}-31"
    db = get_db()
    summary = {}

    def slot(day):
        return summary.setdefault(day, {"note": False, "trackers": [], "entries": 0})

    # Trackers logged per day (only those flagged to show on the calendar), in
    # stable tracker order, with each entry's value so the UI can show numbers.
    for r in db.execute(
        """
        SELECT e.day AS day, e.tracker_id AS tid, e.value AS value
          FROM entries e JOIN trackers t ON t.id = e.tracker_id
         WHERE e.day BETWEEN ? AND ? AND t.calendar = 1
         ORDER BY t.position, t.id
        """,
        (start, end),
    ).fetchall():
        s = slot(r["day"])
        s["trackers"].append({"id": r["tid"], "value": r["value"]})
        s["entries"] = len(s["trackers"])

    for r in db.execute(
        "SELECT day FROM notes WHERE day BETWEEN ? AND ? AND text != ''",
        (start, end),
    ).fetchall():
        slot(r["day"])["note"] = True

    return jsonify({"year": year, "month": month, "days": summary})


# ----- static frontend -----

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8001)
