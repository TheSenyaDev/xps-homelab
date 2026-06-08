"""SQLite access + schema + first-run seed.

Schema is intentionally small and additive — new features should add tables or
columns (with a migration in `migrate()`) rather than reshape these.
"""
import os
import sqlite3

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#6366f1',
    -- 'expense' counts toward spending, 'income' toward income,
    -- 'transfer' is internal money movement (excluded from both).
    kind       TEXT NOT NULL DEFAULT 'expense',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern     TEXT NOT NULL,
    is_regex    INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 100,  -- lower wins
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    hash        TEXT NOT NULL UNIQUE,          -- dedupe key (see ingest)
    date        TEXT NOT NULL,                 -- YYYY-MM-DD
    month       TEXT NOT NULL,                 -- YYYY-MM (for fast grouping)
    merchant    TEXT NOT NULL,
    amount      REAL NOT NULL,                 -- always positive
    direction   TEXT NOT NULL,                 -- 'out' (spent) | 'in' (received)
    account     TEXT NOT NULL,
    bank        TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_month ON transactions(month);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account);
"""

# (name, color, kind)
DEFAULT_CATEGORIES = [
    ("Groceries", "#22c55e", "expense"),
    ("Dining", "#f59e0b", "expense"),
    ("Transport", "#3b82f6", "expense"),
    ("Shopping", "#a855f7", "expense"),
    ("Bills & Utilities", "#ef4444", "expense"),
    ("Subscriptions", "#8b5cf6", "expense"),
    ("Entertainment", "#ec4899", "expense"),
    ("Health", "#14b8a6", "expense"),
    ("Fees", "#f97316", "expense"),
    ("Income", "#10b981", "income"),
    ("Transfer", "#6b7280", "transfer"),
]

# (regex pattern, category name, priority) — first match by priority wins.
# Deliberately conservative; users refine via the Manage view.
DEFAULT_RULES = [
    (r"PAYMENT THANK YOU|PAIEMEN|INTERNET (BANKING )?TRANSFER|TRANSFER TO CARD|TO CARD \d", "Transfer", 10),
    (r"UBER ?EATS|DOORDASH|SKIP ?THE ?DISHES|SKIPTHEDISHES", "Dining", 20),
    (r"TIM HORTON|MCDONALD|STARBUCK|RESTAUR|PIZZA|A&W|SUBWAY|BURGER|\bCAFE\b|COFFEE", "Dining", 30),
    (r"COSTCO|LOBLAW|NO ?FRILLS|\bMETRO\b|FARM BOY|SOBEYS|FRESHCO|FOOD BASIC|SUPERSTORE|GROCER", "Groceries", 40),
    (r"ESSO|PETRO|SHELL|GAS BAR|CIRCLE K|PRESTO|\bTTC\b|LYFT|\bUBER\b|PARKING|GO TRANSIT", "Transport", 50),
    (r"AMZN|AMAZON|BEST BUY|SPORT ?CHEK|CANADIAN TIRE|IKEA|WALMART", "Shopping", 60),
    (r"NETFLIX|SPOTIFY|DISNEY|CRUNCHYROLL|PATREON|PRIME ?VIDEO|YOUTUBEPREMIUM", "Subscriptions", 70),
    (r"GOOGLE|APPLE\.COM|MICROSOFT|OPENAI|ANTHROPIC|CLAUDE\.AI", "Subscriptions", 75),
    (r"HYDRO|ROGERS|BELL CANADA|TELUS|\bFIDO\b|ENBRIDGE|INSURANCE|UTILIT", "Bills & Utilities", 80),
]


def get_db():
    if "db" not in g:
        path = current_app.config["DB_PATH"]
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        g.db = conn
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def migrate(conn):
    """Additive migrations for older DBs go here."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(categories)").fetchall()}
    if cols and "kind" not in cols:
        conn.execute("ALTER TABLE categories ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'")


def seed(conn):
    if conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]:
        return
    for name, color, kind in DEFAULT_CATEGORIES:
        conn.execute("INSERT INTO categories (name, color, kind) VALUES (?, ?, ?)", (name, color, kind))
    ids = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM categories").fetchall()}
    for pattern, cat, priority in DEFAULT_RULES:
        if cat in ids:
            conn.execute(
                "INSERT INTO rules (pattern, is_regex, category_id, priority) VALUES (?, 1, ?, ?)",
                (pattern, ids[cat], priority),
            )


def init_db(app):
    path = app.config["DB_PATH"]
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    migrate(conn)
    seed(conn)
    conn.commit()
    conn.close()
