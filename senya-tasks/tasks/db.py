"""SQLite schema, migrations and connection handling.

BASELINE is the original v0 schema. Every later change is a numbered step in
MIGRATIONS, applied in order and tracked in `PRAGMA user_version`. A fresh
database is created at the baseline and then migrated up, so the upgrade path
runs on every install rather than only on the one old DB in production.

To extend: append a new entry to MIGRATIONS. Never edit a released one —
databases that already ran it won't run it again.
"""
import logging
import os
import sqlite3

from flask import g

from .config import DB_PATH, PRIORITIES, STATUSES

log = logging.getLogger("senya-tasks.db")

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

# App preferences, as a key/value table. A table rather than a file because the
# DB is already the thing that gets backed up, and these belong with the tasks
# they describe.
M7 = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# Subtasks. A task may hang off another; deleting a parent takes its children
# with it, which is what "delete this task" means when the children only exist
# to describe it.
#
# Self-referential rather than a separate table because a subtask *is* a task —
# it has the same status, priority, due date and CalDAV identity, and splitting
# them would mean duplicating all of that. One level is enforced in the API
# rather than the schema: nesting deeper reads badly in a list and has no
# CalDAV meaning, since RELATED-TO carries no depth.
M8 = """
ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
"""

MIGRATIONS = [M1, M2, M3, M4, M5, M6, M7, M8]
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


def close_db(_exc=None):
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
        log.info("migrated database to schema v%d", i)
    return conn.execute("PRAGMA user_version").fetchone()[0]
