import os
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory

DB_PATH = os.environ.get("DB_PATH", "/data/tasks.db")
MARKDOWN_PATH = os.environ.get("MARKDOWN_PATH", "/data/Tasks.md")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

app = Flask(__name__, static_folder=None)

SCHEMA = """
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
    # migrate older DBs that predate subcategories
    cols = [r[1] for r in conn.execute("PRAGMA table_info(categories)").fetchall()]
    if "parent_id" not in cols:
        conn.execute(
            "ALTER TABLE categories ADD COLUMN parent_id INTEGER "
            "REFERENCES categories(id) ON DELETE CASCADE"
        )
    conn.commit()
    write_markdown(conn)
    conn.close()


# ----- markdown export (Obsidian-friendly) -----

PRIORITY_LABEL = {"high": "🔺 high", "medium": "🔼 medium", "low": "🔽 low"}


def build_markdown(conn):
    cats = [dict(r) for r in conn.execute("SELECT * FROM categories").fetchall()]
    tasks = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM tasks ORDER BY done, priority, created_at DESC"
        ).fetchall()
    ]

    children = defaultdict(list)
    for c in cats:
        children[c["parent_id"]].append(c)
    for kids in children.values():
        kids.sort(key=lambda c: c["name"].lower())

    tasks_by_cat = defaultdict(list)
    for t in tasks:
        tasks_by_cat[t["category_id"]].append(t)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    total = len(tasks)
    open_count = sum(1 for t in tasks if not t["done"])
    lines = [
        "---",
        "title: Tasks",
        "tags: [tasks]",
        f"updated: {now} UTC",
        "---",
        "",
        "# 📋 Tasks",
        "",
        f"> [!info] Auto-generated from the task tracker — do not edit by hand.",
        f"> Last updated {now} UTC · {open_count} open / {total} total.",
        "",
    ]

    def render_task(t):
        box = "x" if t["done"] else " "
        label = PRIORITY_LABEL.get(t["priority"], t["priority"])
        return f"- [{box}] {t['title']}  `{label}`"

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


# ----- API: categories -----

@app.get("/api/categories")
def list_categories():
    rows = get_db().execute("SELECT * FROM categories ORDER BY name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/categories")
def create_category():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    color = (data.get("color") or "#6366f1").strip()
    parent_id = data.get("parent_id")
    db = get_db()

    if parent_id is not None:
        if db.execute("SELECT 1 FROM categories WHERE id = ?", (parent_id,)).fetchone() is None:
            return jsonify({"error": "parent category not found"}), 400

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
        return jsonify({"error": "category already exists here"}), 409

    cur = db.execute(
        "INSERT INTO categories (name, color, parent_id) VALUES (?, ?, ?)",
        (name, color, parent_id),
    )
    db.commit()
    sync()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.delete("/api/categories/<int:cat_id>")
def delete_category(cat_id):
    db = get_db()
    db.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
    db.commit()
    sync()
    return "", 204


# ----- API: tasks -----

@app.get("/api/tasks")
def list_tasks():
    rows = get_db().execute("SELECT * FROM tasks ORDER BY done, created_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/tasks")
def create_task():
    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    priority = data.get("priority") if data.get("priority") in ("low", "medium", "high") else "medium"
    category_id = data.get("category_id")
    db = get_db()
    cur = db.execute(
        "INSERT INTO tasks (title, priority, category_id) VALUES (?, ?, ?)",
        (title, priority, category_id),
    )
    db.commit()
    sync()
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.patch("/api/tasks/<int:task_id>")
def update_task(task_id):
    data = request.get_json(force=True) or {}
    fields, values = [], []
    if "title" in data:
        title = (data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "title cannot be empty"}), 400
        fields.append("title = ?")
        values.append(title)
    if "done" in data:
        fields.append("done = ?")
        values.append(1 if data["done"] else 0)
    if "priority" in data and data["priority"] in ("low", "medium", "high"):
        fields.append("priority = ?")
        values.append(data["priority"])
    if "category_id" in data:
        fields.append("category_id = ?")
        values.append(data["category_id"])
    if not fields:
        return jsonify({"error": "nothing to update"}), 400
    values.append(task_id)
    db = get_db()
    db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?", values)
    db.commit()
    sync()
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(dict(row))


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
