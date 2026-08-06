import os
import re
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory

DB_PATH = os.environ.get("DB_PATH", "/data/tasks.db")
MARKDOWN_PATH = os.environ.get("MARKDOWN_PATH", "/data/Tasks.md")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

app = Flask(__name__, static_folder=None)

# Vocabularies. Adding a value here is most of what it takes for the API and the
# /api/meta-driven UI pickers to accept it (the CHECK constraints live in a
# migration, so widening those needs a new one) — order is display/sort order.
STATUSES = ("todo", "doing", "blocked", "done")
PRIORITIES = ("high", "medium", "low")

# ============================================================
#  Schema
#
#  BASELINE is the original v0 schema. Every later change is a numbered step in
#  MIGRATIONS, applied in order and tracked in `PRAGMA user_version`. A fresh
#  database is created at the baseline and then migrated up, so the upgrade path
#  runs on every install rather than only on the one old DB in production.
#
#  To extend: append a new entry to MIGRATIONS. Never edit a released one —
#  databases that already ran it won't run it again.
# ============================================================

BASELINE = """
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6366f1',
    parent_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parent_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0,
    priority    TEXT NOT NULL DEFAULT 'medium',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

_STATUS_SQL = ", ".join(f"'{s}'" for s in STATUSES)
_PRIORITY_SQL = ", ".join(f"'{p}'" for p in PRIORITIES)

# --- 1: richer tasks -------------------------------------------------------
# `done` becomes `status` (a boolean can't express "in progress" or "blocked"),
# plus notes, a due date, manual ordering and audit timestamps. SQLite can't add
# CHECK constraints to an existing table, so the table is rebuilt and the rows
# copied across.
M1 = f"""
CREATE TABLE tasks_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ({_STATUS_SQL})),
    priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ({_PRIORITY_SQL})),
    category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    due_date     TEXT,                                   -- YYYY-MM-DD, or NULL
    position     INTEGER NOT NULL DEFAULT 0,             -- manual ordering
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT                                    -- set when status = done
);

INSERT INTO tasks_new (id, title, status, priority, category_id, position,
                       created_at, updated_at, completed_at)
SELECT id, title,
       CASE WHEN done THEN 'done' ELSE 'todo' END,
       CASE WHEN priority IN ({_PRIORITY_SQL}) THEN priority ELSE 'medium' END,
       category_id, id, created_at, created_at,
       CASE WHEN done THEN created_at END
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX tasks_category_idx ON tasks(category_id);
CREATE INDEX tasks_status_idx   ON tasks(status);
CREATE INDEX tasks_due_idx      ON tasks(due_date);

-- Keep the audit columns honest no matter who writes to the DB (the app, a
-- script, the sqlite3 CLI). Recursive triggers are off by default, so the
-- writes these make don't re-fire them.
CREATE TRIGGER tasks_touch AFTER UPDATE ON tasks
BEGIN
    UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER tasks_completed_ins AFTER INSERT ON tasks WHEN NEW.status = 'done'
BEGIN
    UPDATE tasks SET completed_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER tasks_completed_upd AFTER UPDATE OF status ON tasks
WHEN NEW.status IS NOT OLD.status
BEGIN
    UPDATE tasks
       SET completed_at = CASE WHEN NEW.status = 'done' THEN datetime('now') END
     WHERE id = NEW.id;
END;
"""

# --- 2: tags ---------------------------------------------------------------
# Cross-cutting labels ("errand", "waiting") that don't fit the single-parent
# category tree a task already sits in.
M2 = """
CREATE TABLE tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#64748b',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX task_tags_tag_idx ON task_tags(tag_id);
"""

# --- 3: orderable categories ----------------------------------------------
M3 = """
ALTER TABLE categories ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE categories SET position = id;
"""

MIGRATIONS = [M1, M2, M3]
SCHEMA_VERSION = len(MIGRATIONS)


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


def migrate(conn):
    """Bring the DB from whatever version it's at up to SCHEMA_VERSION."""
    conn.executescript(BASELINE)  # no-ops on an existing DB (IF NOT EXISTS)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
        # executescript() commits any open transaction, so drive the transaction
        # explicitly: a step that fails leaves the DB at the old version rather
        # than half-migrated.
        conn.execute("BEGIN")
        conn.executescript(sql)
        conn.execute(f"PRAGMA user_version = {i}")
        conn.commit()
        app.logger.info("senya-tasks: migrated database to schema v%d", i)
    return conn.execute("PRAGMA user_version").fetchone()[0]


def init_db():
    conn = connect()
    # Migration 1 rebuilds `tasks`; with FK enforcement on, dropping it would
    # trip the categories reference mid-migration.
    conn.execute("PRAGMA foreign_keys = OFF")
    migrate(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    write_markdown(conn)
    conn.close()


# ----- errors -----

class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify({"error": err.message}), err.status


# ----- field validation -----
#
# One table drives create *and* update for tasks: to add a field, add the column
# in a migration, then one line here. Each validator normalises the incoming
# value or raises ApiError. `tags` is handled separately — it isn't a column.

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def v_title(value):
    title = (value or "").strip()
    if not title:
        raise ApiError("title cannot be empty")
    return title[:500]


def v_notes(value):
    return (value or "").strip()


def v_enum(field, allowed):
    def check(value):
        value = str(value or "").strip().lower()
        if value not in allowed:
            raise ApiError(f"{field} must be one of: {', '.join(allowed)}")
        return value
    return check


def v_due_date(value):
    if value in (None, ""):
        return None
    value = str(value).strip()
    if not DATE_RE.match(value):
        raise ApiError("due_date must be YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError("due_date is not a real date")
    return value


def v_category_id(value):
    if value in (None, ""):
        return None
    try:
        cid = int(value)
    except (TypeError, ValueError):
        raise ApiError("category_id must be an integer or null")
    if get_db().execute("SELECT 1 FROM categories WHERE id = ?", (cid,)).fetchone() is None:
        raise ApiError("category not found")
    return cid


def v_int(field):
    def check(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ApiError(f"{field} must be an integer")
    return check


TASK_FIELDS = {
    "title": v_title,
    "notes": v_notes,
    "status": v_enum("status", STATUSES),
    "priority": v_enum("priority", PRIORITIES),
    "category_id": v_category_id,
    "due_date": v_due_date,
    "position": v_int("position"),
}


def task_columns(data):
    """{column: value} for every recognised field present in the payload."""
    out = {}
    for field, validate in TASK_FIELDS.items():
        if field in data:
            out[field] = validate(data[field])
    # `done` is no longer a column, but it's the natural thing for a checkbox
    # (and for older clients) to send, so accept it as a shortcut for status.
    if "done" in data and "status" not in data:
        out["status"] = "done" if data["done"] else "todo"
    return out


def v_tag_name(value):
    name = re.sub(r"\s+", "-", str(value or "").strip().lower())
    if not name:
        raise ApiError("tag name cannot be empty")
    return name[:40]


def set_task_tags(db, task_id, names):
    """Replace a task's tags, creating any that don't exist yet."""
    if not isinstance(names, list):
        raise ApiError("tags must be a list of names")
    wanted = {v_tag_name(n) for n in names}
    db.execute("DELETE FROM task_tags WHERE task_id = ?", (task_id,))
    for name in sorted(wanted):
        db.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        db.execute(
            "INSERT INTO task_tags (task_id, tag_id) "
            "VALUES (?, (SELECT id FROM tags WHERE name = ?))",
            (task_id, name),
        )


# ----- serialisation -----

def tags_by_task(db, task_ids=None):
    rows = db.execute(
        "SELECT tt.task_id, t.name, t.color FROM task_tags tt "
        "JOIN tags t ON t.id = tt.tag_id ORDER BY t.name"
    ).fetchall()
    out = defaultdict(list)
    for r in rows:
        if task_ids is None or r["task_id"] in task_ids:
            out[r["task_id"]].append({"name": r["name"], "color": r["color"]})
    return out


def task_json(row, tags):
    t = dict(row)
    t["done"] = t["status"] == "done"  # convenience mirror of status
    t["tags"] = tags
    return t


def read_task(db, task_id):
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return task_json(row, tags_by_task(db, {task_id}).get(task_id, []))


# ----- markdown export (Obsidian-friendly) -----
#
# Emoji follow the Obsidian Tasks plugin's syntax so the file stays queryable
# there: ⏫/🔼/🔽 priority, 📅 due date, ✅ completion date.

PRIORITY_EMOJI = {"high": "⏫", "medium": "🔼", "low": "🔽"}
STATUS_BOX = {"todo": " ", "doing": "/", "blocked": "!", "done": "x"}


def build_markdown(conn):
    cats = [dict(r) for r in conn.execute(
        "SELECT * FROM categories ORDER BY position, name").fetchall()]
    tasks = [dict(r) for r in conn.execute(
        "SELECT * FROM tasks ORDER BY status = 'done', position, id").fetchall()]
    tags = tags_by_task(conn)

    children = defaultdict(list)
    for c in cats:
        children[c["parent_id"]].append(c)

    tasks_by_cat = defaultdict(list)
    for t in tasks:
        tasks_by_cat[t["category_id"]].append(t)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    total = len(tasks)
    open_count = sum(1 for t in tasks if t["status"] != "done")
    lines = [
        "---",
        "title: SenyaTasks",
        "tags: [tasks]",
        f"updated: {now} UTC",
        "---",
        "",
        "# 📋 SenyaTasks",
        "",
        "> [!info] Auto-generated by SenyaTasks — do not edit by hand.",
        f"> Last updated {now} UTC · {open_count} open / {total} total.",
        "",
    ]

    def render_task(t):
        parts = [f"- [{STATUS_BOX.get(t['status'], ' ')}] {t['title']}"]
        parts += [f"#{tag['name']}" for tag in tags.get(t["id"], [])]
        if t["status"] in ("doing", "blocked"):
            parts.append(f"`{t['status']}`")
        parts.append(PRIORITY_EMOJI.get(t["priority"], ""))
        if t["due_date"]:
            parts.append(f"📅 {t['due_date']}")
        if t["completed_at"]:
            parts.append(f"✅ {t['completed_at'][:10]}")
        line = " ".join(p for p in parts if p)
        if t["notes"]:
            line += "\n" + "\n".join(f"    {n}" for n in t["notes"].splitlines())
        return line

    def walk(parent_id, level):
        for c in children.get(parent_id, []):
            lines.append(f"{'#' * min(level, 6)} {c['name']}")
            lines.append("")
            ctasks = tasks_by_cat.get(c["id"], [])
            if ctasks:
                lines.extend(render_task(t) for t in ctasks)
                lines.append("")
            walk(c["id"], level + 1)

    walk(None, 2)

    uncategorized = tasks_by_cat.get(None, [])
    if uncategorized:
        lines.append("## Uncategorized")
        lines.append("")
        lines.extend(render_task(t) for t in uncategorized)
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def write_markdown(conn):
    content = build_markdown(conn)
    os.makedirs(os.path.dirname(MARKDOWN_PATH) or ".", exist_ok=True)
    tmp = MARKDOWN_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, MARKDOWN_PATH)  # atomic so Obsidian never sees a partial file


def sync():
    """Call after any mutation to keep Tasks.md in lock-step with the DB."""
    write_markdown(get_db())


# ----- API: meta -----

@app.get("/api/meta")
def meta():
    """Everything a client needs to build its pickers without hardcoding them."""
    db = get_db()
    counts = dict(db.execute(
        "SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall())
    return jsonify({
        "schema_version": db.execute("PRAGMA user_version").fetchone()[0],
        "statuses": list(STATUSES),
        "priorities": list(PRIORITIES),
        "counts": {s: counts.get(s, 0) for s in STATUSES},
        "markdown_path": MARKDOWN_PATH,
    })


# ----- API: categories -----

@app.get("/api/categories")
def list_categories():
    rows = get_db().execute(
        "SELECT * FROM categories ORDER BY position, name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/categories")
def create_category():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        raise ApiError("name is required")
    color = (data.get("color") or "#6366f1").strip()
    parent_id = data.get("parent_id")
    db = get_db()

    if parent_id is not None:
        if db.execute("SELECT 1 FROM categories WHERE id = ?", (parent_id,)).fetchone() is None:
            raise ApiError("parent category not found")

    # explicit dup check (UNIQUE treats NULL parents as distinct, so guard here)
    if parent_id is None:
        dup = db.execute(
            "SELECT 1 FROM categories WHERE name = ? AND parent_id IS NULL", (name,)
        ).fetchone()
    else:
        dup = db.execute(
            "SELECT 1 FROM categories WHERE name = ? AND parent_id = ?", (name, parent_id)
        ).fetchone()
    if dup:
        raise ApiError("category already exists here", 409)

    nxt = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories").fetchone()[0]
    cur = db.execute(
        "INSERT INTO categories (name, color, parent_id, position) VALUES (?, ?, ?, ?)",
        (name, color, parent_id, nxt),
    )
    db.commit()
    sync()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.patch("/api/categories/<int:cat_id>")
def update_category(cat_id):
    data = request.get_json(force=True, silent=True) or {}
    fields, values = [], []
    for key in ("name", "color"):
        if key in data:
            val = (data[key] or "").strip()
            if not val:
                raise ApiError(f"{key} cannot be empty")
            fields.append(f"{key} = ?")
            values.append(val)
    if "position" in data:
        fields.append("position = ?")
        values.append(v_int("position")(data["position"]))
    if "parent_id" in data:
        parent_id = data["parent_id"]
        if parent_id not in (None, ""):
            parent_id = int(parent_id)
            if parent_id == cat_id:
                raise ApiError("a category cannot be its own parent")
        else:
            parent_id = None
        fields.append("parent_id = ?")
        values.append(parent_id)
    if not fields:
        raise ApiError("nothing to update")
    db = get_db()
    if db.execute("SELECT 1 FROM categories WHERE id = ?", (cat_id,)).fetchone() is None:
        raise ApiError("not found", 404)
    values.append(cat_id)
    db.execute(f"UPDATE categories SET {', '.join(fields)} WHERE id = ?", values)
    db.commit()
    sync()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
    return jsonify(dict(row))


@app.delete("/api/categories/<int:cat_id>")
def delete_category(cat_id):
    db = get_db()
    db.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
    db.commit()
    sync()
    return "", 204


# ----- API: tags -----

@app.get("/api/tags")
def list_tags():
    rows = get_db().execute(
        "SELECT t.*, COUNT(tt.task_id) AS task_count FROM tags t "
        "LEFT JOIN task_tags tt ON tt.tag_id = t.id GROUP BY t.id ORDER BY t.name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.patch("/api/tags/<int:tag_id>")
def update_tag(tag_id):
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    if db.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
        raise ApiError("not found", 404)
    if "color" in data:
        db.execute("UPDATE tags SET color = ? WHERE id = ?",
                   ((data["color"] or "").strip(), tag_id))
    if "name" in data:
        db.execute("UPDATE tags SET name = ? WHERE id = ?",
                   (v_tag_name(data["name"]), tag_id))
    db.commit()
    sync()
    row = db.execute("SELECT * FROM tags WHERE id = ?", (tag_id,)).fetchone()
    return jsonify(dict(row))


@app.delete("/api/tags/<int:tag_id>")
def delete_tag(tag_id):
    db = get_db()
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    db.commit()
    sync()
    return "", 204


# ----- API: tasks -----

@app.get("/api/tasks")
def list_tasks():
    """Optional filters: ?status= ?priority= ?category_id= ?tag= ?q= ?due_before="""
    db = get_db()
    args = request.args
    where, params = [], []

    if "status" in args:
        where.append("status = ?")
        params.append(v_enum("status", STATUSES)(args["status"]))
    if "priority" in args:
        where.append("priority = ?")
        params.append(v_enum("priority", PRIORITIES)(args["priority"]))
    if "category_id" in args:
        where.append("category_id IS ?")
        params.append(None if args["category_id"] in ("", "none") else int(args["category_id"]))
    if "due_before" in args:
        where.append("(due_date IS NOT NULL AND due_date <= ?)")
        params.append(v_due_date(args["due_before"]))
    if args.get("q"):
        where.append("(title LIKE ? OR notes LIKE ?)")
        params += [f"%{args['q']}%"] * 2
    if args.get("tag"):
        where.append(
            "id IN (SELECT tt.task_id FROM task_tags tt JOIN tags g ON g.id = tt.tag_id "
            "WHERE g.name = ?)")
        params.append(v_tag_name(args["tag"]))

    sql = "SELECT * FROM tasks"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY status = 'done', position, id"

    rows = db.execute(sql, params).fetchall()
    tags = tags_by_task(db, {r["id"] for r in rows})
    return jsonify([task_json(r, tags.get(r["id"], [])) for r in rows])


@app.post("/api/tasks")
def create_task():
    data = request.get_json(force=True, silent=True) or {}
    if "title" not in data:
        raise ApiError("title is required")
    cols = task_columns(data)
    db = get_db()
    cols.setdefault(
        "position",
        db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM tasks").fetchone()[0],
    )
    cur = db.execute(
        f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
        list(cols.values()),
    )
    if "tags" in data:
        set_task_tags(db, cur.lastrowid, data["tags"])
    db.commit()
    sync()
    return jsonify(read_task(db, cur.lastrowid)), 201


@app.patch("/api/tasks/<int:task_id>")
def update_task(task_id):
    data = request.get_json(force=True, silent=True) or {}
    cols = task_columns(data)
    if not cols and "tags" not in data:
        raise ApiError("nothing to update")
    db = get_db()
    if db.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone() is None:
        raise ApiError("not found", 404)
    if cols:
        db.execute(
            f"UPDATE tasks SET {', '.join(f'{c} = ?' for c in cols)} WHERE id = ?",
            [*cols.values(), task_id],
        )
    if "tags" in data:
        set_task_tags(db, task_id, data["tags"])
    db.commit()
    sync()
    return jsonify(read_task(db, task_id))


@app.post("/api/tasks/reorder")
def reorder_tasks():
    """Body: {"ids": [3, 1, 2]} — writes `position` in the order given."""
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list):
        raise ApiError("ids must be a list of task ids")
    db = get_db()
    for pos, tid in enumerate(ids, start=1):
        db.execute("UPDATE tasks SET position = ? WHERE id = ?", (pos, int(tid)))
    db.commit()
    sync()
    return "", 204


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id):
    db = get_db()
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    sync()
    return "", 204


# ----- static frontend -----

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
