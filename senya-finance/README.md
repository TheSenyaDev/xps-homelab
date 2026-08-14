# SenyaFinance

Self-hosted spending tracker for the senya homelab. Reads bank CSV exports from
the read-only **TrueNAS SMB mount**, normalizes + de-duplicates them into SQLite,
auto-categorizes via rules, and shows spending **per month** and **by category**.
Anything it can't recognize is flagged **Uncategorized** for you to label (and
optionally turn into a rule).

Built **modular-first** (Flask app factory + blueprints + a pluggable parser
registry) so new banks, views, and features drop in without reshaping the core.

## Architecture

```
wsgi.py                 -> finance.create_app()
finance/
  config.py             paths/flags (DB_PATH, IMPORT_DIR, AUTO_IMPORT)
  db.py                 schema + defaults (re-seeded on every boot) + migrations
  categorize.py         rule engine (pure functions)
  spending.py           what counts as spending/income — one source of truth
  recurring.py          recurring-charge detection (pure functions)
  ingest/
    parsers.py          Source registry + per-bank CSV parsers
    __init__.py         run_import(): scan -> parse -> dedupe -> insert
  api/                  one Blueprint per area
    transactions.py · categories.py · rules.py · summary.py · imports.py
    trends.py · recurring.py
  static/               ES-module frontend
    views/              dashboard · trends · recurring · transactions · categories
tests/                  pytest suite for the pure logic (recurring detection)
```

### Data model
- **transactions** — `date, month, merchant, amount, direction(out/in), account, bank, category_id, hash`
- **categories** — `name, color, kind(expense|income|transfer)`
- **rules** — `pattern, is_regex, category_id, priority` (first match wins)

`spending` = money **out** that's uncategorized or in an *expense* category
(transfers/income excluded, so credit-card payments don't double-count). The SQL
for this lives in `spending.py` and is imported by every aggregation, so two
screens can't drift into reporting different totals for the same month.

## Views

- **Dashboard** — one month: totals, category breakdown, top merchants.
- **Trends** — one *year*, against the year before it: monthly bars with last
  year behind them, and a category table showing what grew and by how much.
- **Subscriptions** — recurring charges found in the history, what they cost per
  month and per year, when each is next due, and which ones went up in price.
- **Transactions** — filter, categorize (one row or many at once), make rules.
- **Categories & Rules** — the vocabulary, the rules, and suggested rules.

### How recurring detection works

`recurring.py` looks for *same merchant, similar amount, evenly spaced* — no
per-merchant list to maintain, so a gym, an insurance policy and a car loan are
found the same way Netflix is. Charges need at least 3 occurrences and a gap
that matches a known cadence (weekly → yearly). Amounts more than 35% off the
median are treated as a different purchase from the same merchant and excluded,
so a one-off Amazon order doesn't hide a monthly subscription.

Two details worth knowing:

- **Merchant names are normalized** before grouping — bank descriptors carry
  reference and store numbers that change every month, which would otherwise
  make a 6-month series look like 6 one-offs.
- **"Active" is judged against the newest imported transaction, not today.**
  Statements arrive in batches; measured against the wall clock, every
  subscription would look cancelled for as long as it's been since the last
  import. The UI shows the date it's reasoning from.

## Extending it

- **New bank/account:** add a parser + `register(Source(...))` in
  `ingest/parsers.py`. Recognition is by file path; nothing else changes.
- **New API/feature:** add `finance/api/<feature>.py` exposing a `bp` and list it
  in `api/__init__.py:all_blueprints()`.
- **New field type / view:** add a `static/js/views/<name>.js` and register it in
  `static/js/main.js`.

## Data source

The CSVs come from the `finance-smb` CIFS volume (TrueNAS `//192.168.2.82/Finance`,
read-only) mounted at `/import`. Auto-imports on first boot; click **⟳ Import**
(or `POST /api/import`) to pick up new files later. Recognized today:
CIBC Mastercard/Visa/Chequing, TD Visa. (TD chequing is PDF-only — not yet parsed.)

## Run

```bash
docker compose up -d --build senya-finance      # http://localhost:8002
```

Data (SQLite) lives in `./data/` (git-ignored). Re-importing never overwrites
your manual categorizations — only genuinely new transactions are added.

**Defaults are topped up on every boot.** `seed()` adds any default category or
rule the database doesn't have yet, matching on name and on pattern. Categories
you renamed or recoloured are left alone, and nothing is duplicated — but it
also means deleting a *default* rule isn't permanent (it returns on restart);
edit its pattern instead. New rules only fill in blanks: run **Apply to
uncategorized** to backfill, which can't touch a category you set by hand.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/transactions` | filters: `month, account, category_id, uncategorized=1, q, limit, offset` |
| PATCH | `/api/transactions/:id` | `{category_id}` (null to clear) |
| PATCH | `/api/transactions/bulk` | `{ids: [...], category_id}` — label many at once |
| GET/POST/PATCH/DELETE | `/api/categories[/:id]` | `{name,color,kind}` |
| GET/POST/DELETE | `/api/rules[/:id]` | `{pattern,is_regex,category_id,priority}` |
| POST | `/api/rules/apply[?scope=all]` | fill in uncategorized rows; `scope=all` also re-runs over already-categorized ones (can overwrite manual labels) |
| POST | `/api/rules/preview` | `{pattern,is_regex}` → what it *would* match, before saving |
| GET | `/api/rules/suggestions` | repeated uncategorized merchants worth a rule |
| GET | `/api/summary/monthly?months=N` · `/api/summary/by-category?month=` · `/api/overview?month=` | dashboards |
| GET | `/api/trends/years` · `/api/trends/monthly?year=` · `/api/trends/by-category?year=` | year view + year-over-year |
| GET | `/api/recurring?years=N` | detected subscriptions, cost per month/year, price rises |
| POST | `/api/import` · GET `/api/import/status` | re-scan the SMB folder |

## Tests

```bash
docker run --rm -v "$PWD:/app" -w /app senya-finance:latest \
  sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
```

Covers the recurring detector — the one piece with enough judgement in it
(cadence fitting, outlier amounts, what "active" means) to be worth pinning down.
