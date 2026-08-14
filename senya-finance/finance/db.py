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

-- One recurring monthly budget per category. Keyed by category rather than by
-- (category, month): a budget is a standing intention ("$600 of groceries a
-- month"), and per-month overrides would mean re-entering every number every
-- month to keep the comparison meaningful.
CREATE TABLE IF NOT EXISTS budgets (
    category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
    amount      REAL NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
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
    ("Student Loans", "#6366f1", "expense"),
    ("Income", "#10b981", "income"),
    ("Transfer", "#6b7280", "transfer"),
    # Money moved into your own investment accounts is not spending.
    ("Investments", "#0ea5e9", "transfer"),
    # Cash leaving the account: really spent, but the statement can't say on what.
    ("Cash & ATM", "#eab308", "expense"),
    ("Car Loan", "#f43f5e", "expense"),
    # Interac e-transfers (rent, splitting bills, paying people back).
    ("E-Transfers", "#94a3b8", "expense"),
]

# (regex pattern, category name, priority) — first match by priority wins.
# Deliberately conservative; users refine via the Manage view.
DEFAULT_RULES = [
    # Paying a credit card off from chequing is *not* spending — the card's own
    # transactions are already imported, so counting the payment too would
    # double-count every dollar that passes through the card.
    (r"INTERNET BILL PAY.*(VISA|MASTERCARD|SCOTIABANK CREDIT CARD|CREDIT CARD|AMEX|AMERICAN EXPRESS)",
     "Transfer", 5),
    (r"PAYMENT THANK YOU|PAIEMEN|INTERNET (BANKING )?TRANSFER|TRANSFER TO CARD|TO CARD \d", "Transfer", 10),
    (r"QUESTRADE|SHAREOWNER INVESTMENT|CIBC SECURITIES|CIBC-DISATF|COINBASE", "Investments", 12),
    # Wealthsimple activity exports name the *activity* where a bank names a
    # merchant: a trade reads "BUY AAPL", a funding row reads just "Deposit".
    # Anchored to the start so they can only ever match those rows — an
    # unanchored "BUY" or "INTEREST" would swallow real merchants.
    (r"^(BUY|SELL|DIVIDEND|REINVESTMENT|STOCK (SPLIT|DIVIDEND)|OPTIONS? )", "Investments", 11),
    # Money you moved into your own Wealthsimple account, not money earned or
    # spent — the funding side is already recorded on the bank account it left,
    # so counting it here too would double it.
    (r"^(DEPOSIT|WITHDRAWAL|CONTRIBUTION|TRANSFER (IN|OUT)|INTERNAL TRANSFER|EFT)\b", "Transfer", 11),
    (r"ATM WITHDRAWAL|BRANCH TRANSACTION WITHDRAWAL", "Cash & ATM", 14),
    (r"VW CREDIT", "Car Loan", 16),
    (r"E-TRANSFER", "E-Transfers", 18),
    (r"INTERNET BILL PAY.*NATIONAL STUDENT", "Student Loans", 19),
    (r"SERVICE CHARGE|OVERDRAFT|NSF FEE|MONTHLY FEE", "Fees", 19),
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
    """Install the defaults that are missing, on a fresh *or* existing database.

    Matching is by category name and by rule pattern, so this is safe to re-run:
    a database that already has "Groceries" keeps the one it has (including any
    colour or kind the user changed), and only genuinely new defaults are added.
    That matters because new defaults ship after the first boot — the original
    version of this only ran against an empty database, so an existing install
    never picked up later additions.

    Deleting a default category or rule on purpose is respected for categories
    (its rules are skipped) but not for rules — a rule you delete comes back on
    restart. Edit its pattern instead of deleting it if you want it gone.
    """
    have_categories = {r["name"] for r in conn.execute("SELECT name FROM categories").fetchall()}
    for name, color, kind in DEFAULT_CATEGORIES:
        if name not in have_categories:
            conn.execute("INSERT INTO categories (name, color, kind) VALUES (?, ?, ?)", (name, color, kind))

    ids = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM categories").fetchall()}
    have_patterns = {r["pattern"] for r in conn.execute("SELECT pattern FROM rules").fetchall()}
    for pattern, cat, priority in DEFAULT_RULES:
        if cat in ids and pattern not in have_patterns:
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
