"""
SQLite access and schema.

Schema changes are append-only: add a string to `MIGRATIONS` and never edit an
earlier one. `PRAGMA user_version` records how far a database has been brought,
so an existing homelab DB upgrades itself on next start.

Adding the tables a future feature needs (notification prefs, category
favourites, run history) is one more entry in that list.
"""

from __future__ import annotations

import os
import sqlite3

from flask import current_app, g

DEFAULT_DB_PATH = "/data/scraper.db"

BASELINE = """
CREATE TABLE IF NOT EXISTS searches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    site        TEXT NOT NULL,
    query       TEXT NOT NULL,
    sort        TEXT NOT NULL DEFAULT 'best',
    condition   TEXT NOT NULL DEFAULT 'any',
    category    TEXT NOT NULL DEFAULT '',
    min_price   REAL,
    max_price   REAL,
    notify      INTEGER NOT NULL DEFAULT 1,   -- fire events on new/dropped
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_run_at TEXT
);

-- One row per (saved search, item). Kept after an item leaves the results, so a
-- listing that reappears is not announced as new a second time.
CREATE TABLE IF NOT EXISTS listings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id   INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    uid         TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    price       REAL,
    first_price REAL,                          -- price when first seen
    currency    TEXT NOT NULL DEFAULT 'CAD',
    price_text  TEXT NOT NULL DEFAULT '',
    condition   TEXT NOT NULL DEFAULT '',
    shipping    TEXT NOT NULL DEFAULT '',
    seller      TEXT NOT NULL DEFAULT '',
    image       TEXT NOT NULL DEFAULT '',
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    gone        INTEGER NOT NULL DEFAULT 0,    -- absent from the latest run
    UNIQUE(search_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_id, last_seen DESC);
"""

# Site-specific filter values, as a JSON object keyed by site — e.g.
#   {"ebay-ca": {"buying_format": "bin", "free_shipping": true}}
# Keyed by site rather than flat so switching a profile between marketplaces
# keeps each one's settings instead of discarding them, and so one site's
# filters can never be handed to another's URL builder.
M1 = """
ALTER TABLE searches ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
"""

#: Append only. Never edit an entry that has shipped.
MIGRATIONS: list[str] = [M1]


def db_path():
    return current_app.config["DB_PATH"]


def connect(path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect(db_path())
    return g.db


def close_db(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def migrate(conn):
    """Bring a database up to len(MIGRATIONS)."""
    conn.executescript(BASELINE)          # no-ops on an existing DB (IF NOT EXISTS)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
        # executescript() commits any open transaction, so drive it explicitly:
        # a failed step leaves the DB at the old version rather than half-migrated.
        conn.execute("BEGIN")
        try:
            conn.executescript(sql)
            conn.execute(f"PRAGMA user_version = {i}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def init_app(app):
    app.teardown_appcontext(close_db)
    conn = connect(app.config["DB_PATH"])
    try:
        migrate(conn)
    finally:
        conn.close()
