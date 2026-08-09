import os
import re
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory

import caldav

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

# --- 4: CalDAV sync bookkeeping -------------------------------------------
# Everything the sync loop needs to answer "what changed on which side since we
# last agreed?" — one row per synced task plus the server's sync-token.
#
# caldav_map deliberately has NO foreign key onto tasks: deleting a task has to
# leave a tombstone behind, and a cascade would race the trigger that writes it.
# The trigger owns the cleanup instead, so a local delete always survives long
# enough to be pushed to the server as a DELETE.
M4 = """
CREATE TABLE caldav_map (
    task_id    INTEGER PRIMARY KEY,
    uid        TEXT NOT NULL UNIQUE,   -- VTODO UID, stable for the task's life
    href       TEXT NOT NULL,          -- path of the .ics on the server
    etag       TEXT,                   -- last ETag we saw, for If-Match
    local_rev  TEXT,                   -- tasks.updated_at at last agreement
    remote_rev TEXT                    -- LAST-MODIFIED at last agreement
);

CREATE TABLE caldav_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE caldav_tombstones (
    uid        TEXT PRIMARY KEY,
    href       TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER tasks_caldav_tombstone AFTER DELETE ON tasks
BEGIN
    INSERT OR REPLACE INTO caldav_tombstones (uid, href)
        SELECT uid, href FROM caldav_map WHERE task_id = OLD.id;
    DELETE FROM caldav_map WHERE task_id = OLD.id;
END;
"""

# --- 5: per-object iCalendar SEQUENCE ------------------------------------
# SEQUENCE must increase by one each time we publish a revision of an object.
# It was derived from wall-clock time, which can jump or go backwards — clients
# treat a lower SEQUENCE as a stale update and may ignore the change.
M5 = """
ALTER TABLE caldav_map ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
"""

# --- 6: one calendar collection per category ------------------------------
# A Reminders list *is* a CalDAV collection, so per-category lists mean one
# collection each. Sync tokens are per-collection in WebDAV-Sync, so the single
# token in caldav_state moves in here alongside the mapping.
#
# category_id 0 is the uncategorized bucket: categories are AUTOINCREMENT from
# 1, so 0 can never collide, and a NOT NULL primary key avoids SQLite's rule
# that NULLs are distinct in a UNIQUE index (which would let duplicate
# "uncategorized" rows pile up).
M6 = """
CREATE TABLE caldav_collections (
    category_id INTEGER PRIMARY KEY,   -- 0 = uncategorized
    href        TEXT NOT NULL,         -- server-relative, trailing slash
    display     TEXT,
    sync_token  TEXT
);
"""

MIGRATIONS = [M1, M2, M3, M4, M5, M6]
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
    # Settings saved from the UI override the env defaults.
    caldav.load_config(conn)
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


def build_markdown(conn, include_ids=None):
    """Render the whole DB, or just `include_ids`, as Obsidian-flavoured markdown.

    Filtered exports prune categories whose subtree contributed nothing, so a
    one-category export doesn't carry the rest of the tree as empty headings.
    """
    cats = [dict(r) for r in conn.execute(
        "SELECT * FROM categories ORDER BY position, name").fetchall()]
    tasks = [dict(r) for r in conn.execute(
        "SELECT * FROM tasks ORDER BY status = 'done', position, id").fetchall()]
    if include_ids is not None:
        tasks = [t for t in tasks if t["id"] in include_ids]
    tags = tags_by_task(conn)

    children = defaultdict(list)
    for c in cats:
        children[c["parent_id"]].append(c)

    tasks_by_cat = defaultdict(list)
    for t in tasks:
        tasks_by_cat[t["category_id"]].append(t)

    def subtree_has_tasks(cat_id):
        if tasks_by_cat.get(cat_id):
            return True
        return any(subtree_has_tasks(c["id"]) for c in children.get(cat_id, []))

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
            if include_ids is not None and not subtree_has_tasks(c["id"]):
                continue
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

def task_filters(args):
    """Turn query-string filters into a (WHERE fragment, params) pair.

    Shared by GET /api/tasks and the markdown export so both understand exactly
    the same filters — export what you're looking at, without a second dialect.
    """
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
    if "ids" in args:
        # Lets the client export exactly what's on screen — its search box and
        # tag chips filter client-side, so no server-side filter can reproduce
        # that view. An empty list means "nothing", not "everything".
        ids = [int(x) for x in args["ids"].split(",") if x.strip()]
        where.append(f"id IN ({', '.join('?' * len(ids))})" if ids else "0")
        params += ids

    return (" WHERE " + " AND ".join(where)) if where else "", params


def filtered_tasks(db, args):
    where, params = task_filters(args)
    return db.execute(
        f"SELECT * FROM tasks{where} ORDER BY status = 'done', position, id", params
    ).fetchall()


@app.get("/api/tasks")
def list_tasks():
    """Optional filters: ?status= ?priority= ?category_id= ?tag= ?q= ?due_before="""
    db = get_db()
    rows = filtered_tasks(db, request.args)
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


# ----- API: export -----

@app.get("/api/export")
def export_markdown():
    """The same markdown that lands in Tasks.md, on demand and filterable.

    Accepts every GET /api/tasks filter, so "export what I'm looking at" is one
    request. `?download=1` makes the browser save it instead of showing it.
    """
    db = get_db()
    args = request.args
    filters = {k: v for k, v in args.items() if k != "download"}
    include = None if not filters else {r["id"] for r in filtered_tasks(db, args)}
    text = build_markdown(db, include_ids=include)

    resp = app.response_class(text, mimetype="text/markdown")  # Flask adds the charset
    if args.get("download"):
        name = f"senya-tasks-{date.today().isoformat()}.md"
        resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return resp


# ----- markdown import -----
#
# Parsing is deliberately forgiving — people paste whole Obsidian notes, not
# clean fixtures — but nothing reaches the database from parsing alone. The
# parser only ever *proposes* tasks (each carrying warnings about anything it
# had to guess); the client reviews and edits them, then posts the confirmed
# list back to /api/import/commit. That two-step split is what keeps garbage out.

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*$")
CHECKBOX_RE = re.compile(r"^(?P<indent>[ \t]*)[-*+]\s+\[(?P<box>.)\]\s*(?P<rest>.*)$")
BULLET_RE = re.compile(r"^(?P<indent>[ \t]*)[-*+]\s+(?P<rest>(?!\[.\]).*\S.*)$")
NUMBERED_RE = re.compile(r"^(?P<indent>[ \t]*)\d+[.)]\s+(?P<rest>.*\S.*)$")
TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z0-9][A-Za-z0-9_/-]*)")
DUE_EMOJI_RE = re.compile(r"[📅📆🗓]️?\s*(\d{4}-\d{2}-\d{2})")
DONE_EMOJI_RE = re.compile(r"✅️?\s*(\d{4}-\d{2}-\d{2})")
# Obsidian Tasks fields we understand well enough to strip but don't store.
# Recurrence is the odd one out: its value is a free-text rule ("every 2 weeks
# when done"), so it runs to the end of the line or to the next field emoji,
# while the others take a single date or token.
FIELD_EMOJI = "📅📆🗓✅🛫⏳⌛➕🔁🆔⛔❌🏁"
RECUR_RE = re.compile(rf"(🔁)️?\s*([^{FIELD_EMOJI}]*)")
DROPPED_EMOJI_RE = re.compile(r"([🛫⏳⌛➕🆔⛔❌🏁])️?\s*(\d{4}-\d{2}-\d{2}|\S+)?")
BACKTICK_STATUS_RE = re.compile(r"`\s*(?:[🔺⏫🔼🔽⏬]️?\s*)?(todo|doing|blocked|done|high|medium|low)\s*`",
                                re.IGNORECASE)
PRIORITY_IN = {"🔺": "high", "⏫": "high", "🔼": "medium", "🔽": "low", "⏬": "low"}
BOX_STATUS = {" ": "todo", "": "todo", "x": "done", "X": "done", "/": "doing",
              ">": "doing", "!": "blocked", "?": "blocked"}
DROPPED_LABEL = {"🛫": "start date", "⏳": "scheduled date", "⌛": "scheduled date",
                 "➕": "created date", "🔁": "recurrence rule", "🆔": "id",
                 "⛔": "dependency", "❌": "cancelled date", "🏁": "on-completion action"}


def parse_markdown(text, default_status="todo"):
    """Obsidian markdown → proposed tasks. Never touches the database."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    # Drop YAML frontmatter, which otherwise looks like headings and list items.
    start = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start = i + 1
                break

    # A lone H1 before any task is the note's title (our own export writes one),
    # not a category — otherwise every round-trip nests everything one deeper.
    headings = [(i, m) for i, l in enumerate(lines[start:], start)
                if (m := HEADING_RE.match(l))]
    h1s = [h for h in headings if len(h[1].group(1)) == 1]
    skip_h1 = (
        len(h1s) == 1
        and headings and headings[0][1] is h1s[0][1]
        and not any(CHECKBOX_RE.match(l) for l in lines[start:h1s[0][0]])
    )

    items = []
    stack = []  # [(heading level, name)] → category path
    for lineno, raw in enumerate(lines[start:], start=start + 1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith(">"):
            continue  # blank lines and callouts/quotes carry no tasks

        if (m := HEADING_RE.match(line)):
            level, name = len(m.group(1)), m.group(2).strip()
            if skip_h1 and level == 1:
                stack = []
                continue
            while stack and stack[-1][0] >= level:
                stack.pop()
            if name:
                stack.append((level, name))
            continue

        checkbox = CHECKBOX_RE.match(line)
        bullet = None if checkbox else (BULLET_RE.match(line) or NUMBERED_RE.match(line))

        if not checkbox and not bullet:
            # An indented, non-list line continues the previous task as notes.
            if items and raw[:1] in (" ", "\t") and line.strip():
                items[-1]["notes"] = (items[-1]["notes"] + "\n" + line.strip()).strip()
            continue

        m = checkbox or bullet
        warnings = []
        if checkbox:
            box = m.group("box")
            status = BOX_STATUS.get(box if box.strip() else " ")
            if status is None:
                status = default_status
                warnings.append(f"unrecognised checkbox “{box}” — treated as {status}")
        else:
            status = default_status
            warnings.append("plain list item, not a checkbox")

        rest = m.group("rest").strip()
        item = parse_task_text(rest, warnings)
        item.update({
            "line": lineno,
            "status": status,
            "category_path": [name for _, name in stack],
            # Plain bullets are the most likely source of junk (prose, nav
            # lists), so they arrive unticked and the reviewer opts them in.
            "include": bool(checkbox) and bool(item["title"]),
        })
        if not item["title"]:
            item["warnings"].append("empty title")
        items.append(item)

    return items


def parse_task_text(text, warnings):
    """Pull tags, priority, dates and notes out of one task line's text."""
    tags, priority, due, completed = [], None, None, None

    if (m := DUE_EMOJI_RE.search(text)):
        due = m.group(1)
        text = text[:m.start()] + text[m.end():]
    if (m := DONE_EMOJI_RE.search(text)):
        completed = m.group(1)
        text = text[:m.start()] + text[m.end():]

    def note_dropped(m):
        label = DROPPED_LABEL.get(m.group(1), "field")
        value = (m.group(2) or "").strip()
        warnings.append(f"dropped {label} “{value}”" if value else f"dropped {label}")
        return " "

    text = RECUR_RE.sub(note_dropped, text)
    text = DROPPED_EMOJI_RE.sub(note_dropped, text)

    for emoji, level in PRIORITY_IN.items():
        if emoji in text:
            priority = priority or level
            text = text.replace(emoji, "")

    # our own export writes `doing` / `blocked`; older files wrote `🔺 high`
    for m in list(BACKTICK_STATUS_RE.finditer(text)):
        word = m.group(1).lower()
        if word in PRIORITIES:
            priority = priority or word
    text = BACKTICK_STATUS_RE.sub("", text)

    for m in TAG_RE.finditer(text):
        tags.append(m.group(1).lower())
    text = TAG_RE.sub(" ", text)

    title = re.sub(r"\s{2,}", " ", text.replace("️", "")).strip(" -–—\t")

    if due:
        try:
            date.fromisoformat(due)
        except ValueError:
            warnings.append(f"invalid due date “{due}” — dropped")
            due = None

    return {
        "title": title[:500],
        "notes": "",
        "priority": priority or "medium",
        "due_date": due,
        "completed_at": completed,
        "tags": sorted(dict.fromkeys(tags)),
        "warnings": warnings,
    }


@app.post("/api/import/preview")
def import_preview():
    """Parse pasted markdown and hand back proposed tasks. Writes nothing."""
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("markdown")
    if not isinstance(text, str) or not text.strip():
        raise ApiError("markdown is required")

    items = parse_markdown(text, default_status=v_enum("status", STATUSES)(
        data.get("default_status") or "todo"))

    db = get_db()
    existing = {r["title"].strip().lower() for r in db.execute("SELECT title FROM tasks")}
    known_paths = {}
    for row in db.execute("SELECT id, name, parent_id FROM categories"):
        known_paths[(row["parent_id"], row["name"].lower())] = row["id"]

    seen = set()
    for item in items:
        key = item["title"].strip().lower()
        if key and key in existing:
            item["warnings"].append("a task with this title already exists")
            item["duplicate"] = True
        if key and key in seen:
            item["warnings"].append("duplicated within this paste")
            item["duplicate"] = True
        seen.add(key)

        # Tell the reviewer which categories the import would have to create.
        parent, new_path = None, []
        for name in item["category_path"]:
            found = known_paths.get((parent, name.lower()))
            if found is None:
                new_path.append(name)
                parent = None
                break
            parent = found
        item["new_categories"] = new_path

    return jsonify({
        "items": items,
        "counts": {
            "parsed": len(items),
            "selected": sum(1 for i in items if i["include"]),
            "warnings": sum(1 for i in items if i["warnings"]),
        },
    })


def resolve_category_path(db, path, created):
    """Find (or create) the category chain for ['Work', 'Garage']; None = root."""
    parent = None
    for name in path:
        name = name.strip()
        if not name:
            continue
        row = db.execute(
            "SELECT id FROM categories WHERE name = ? AND parent_id IS ?", (name, parent)
        ).fetchone()
        if row:
            parent = row["id"]
            continue
        nxt = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories").fetchone()[0]
        cur = db.execute(
            "INSERT INTO categories (name, parent_id, position) VALUES (?, ?, ?)",
            (name, parent, nxt),
        )
        parent = cur.lastrowid
        created.append(name)
    return parent


@app.post("/api/import/commit")
def import_commit():
    """Insert the reviewed tasks. All or nothing — a bad row aborts the batch.

    Items come from the client *after* editing, so every field goes back through
    the same TASK_FIELDS validators used by POST /api/tasks; the import path has
    no privileged shortcut into the database.
    """
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items")
    if not isinstance(items, list):
        raise ApiError("items must be a list")
    items = [i for i in items if i.get("include", True)]
    if not items:
        raise ApiError("nothing selected to import")
    make_categories = bool(data.get("create_categories", True))

    db = get_db()
    created_categories = []
    created_ids = []
    try:
        db.execute("BEGIN")
        pos = db.execute("SELECT COALESCE(MAX(position), 0) FROM tasks").fetchone()[0]
        for n, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                raise ApiError(f"item {n} is not an object")
            cols = task_columns(item)
            if not cols.get("title"):
                raise ApiError(f"item {n}: title is required")

            if "category_id" not in item and item.get("category_path"):
                path = item["category_path"]
                if not isinstance(path, list):
                    raise ApiError(f"item {n}: category_path must be a list")
                cols["category_id"] = (
                    resolve_category_path(db, path, created_categories)
                    if make_categories
                    else lookup_category_path(db, path)
                )

            pos += 1
            cols["position"] = pos
            cur = db.execute(
                f"INSERT INTO tasks ({', '.join(cols)}) "
                f"VALUES ({', '.join('?' * len(cols))})",
                list(cols.values()),
            )
            if item.get("tags"):
                set_task_tags(db, cur.lastrowid, item["tags"])
            # Keep the ✅ date from the file. The completed_at trigger stamps
            # "now" on insert, which would silently rewrite history on import.
            if item.get("completed_at") and cols.get("status") == "done":
                db.execute(
                    "UPDATE tasks SET completed_at = ? WHERE id = ?",
                    (v_due_date(item["completed_at"]), cur.lastrowid),
                )
            created_ids.append(cur.lastrowid)
        db.commit()
    except Exception:
        db.rollback()
        raise

    sync()
    return jsonify({
        "created": len(created_ids),
        "categories_created": created_categories,
        "ids": created_ids,
    }), 201


def lookup_category_path(db, path):
    """Resolve a category chain without creating anything; None if incomplete."""
    parent = None
    for name in path:
        row = db.execute(
            "SELECT id FROM categories WHERE name = ? AND parent_id IS ?",
            (name.strip(), parent),
        ).fetchone()
        if row is None:
            return None
        parent = row["id"]
    return parent


# ----- API: CalDAV sync -----

@app.get("/api/caldav")
def caldav_status():
    """Where sync stands: last run, how many tasks are mapped, pending deletes."""
    return jsonify(caldav.status(get_db()))


@app.put("/api/caldav/config")
def caldav_save_config():
    """Save connection settings from the UI.

    The password is write-only: it is never returned by any endpoint, and an
    empty field means "keep the stored one" so re-saving other settings can't
    silently wipe it.
    """
    data = request.get_json(force=True, silent=True) or {}
    try:
        caldav.save_config(get_db(), data)
    except ValueError as e:
        raise ApiError(str(e))
    return jsonify(caldav.status(get_db()))


@app.post("/api/caldav/test")
def caldav_test():
    """Check the settings against the real server without saving them."""
    data = request.get_json(force=True, silent=True) or {}
    return jsonify(caldav.test_connection(get_db(), data))


@app.post("/api/caldav/sync")
def caldav_sync_now():
    """Run a pass immediately instead of waiting for the timer."""
    result = caldav.run_once(connect)
    if "skipped" in result:
        raise ApiError(f"sync not run: {result['skipped']}")
    return jsonify(result)


# ----- static frontend -----

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


init_db()
# Polls in its own thread with its own connection — never on the request path,
# so an unreachable CalDAV server can't stall the API.
caldav.start_worker(connect)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
