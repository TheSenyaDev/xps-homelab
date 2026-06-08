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
  db.py                 schema + first-run seed + migrations
  categorize.py         rule engine (pure functions)
  ingest/
    parsers.py          Source registry + per-bank CSV parsers
    __init__.py         run_import(): scan -> parse -> dedupe -> insert
  api/                  one Blueprint per area
    transactions.py · categories.py · rules.py · summary.py · imports.py
  static/               ES-module frontend (views/ dashboard·transactions·categories)
```

### Data model
- **transactions** — `date, month, merchant, amount, direction(out/in), account, bank, category_id, hash`
- **categories** — `name, color, kind(expense|income|transfer)`
- **rules** — `pattern, is_regex, category_id, priority` (first match wins)

`spending` = money **out** that's uncategorized or in an *expense* category
(transfers/income excluded, so credit-card payments don't double-count).

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

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/transactions` | filters: `month, account, category_id, uncategorized=1, q, limit, offset` |
| PATCH | `/api/transactions/:id` | `{category_id}` (null to clear) |
| GET/POST/PATCH/DELETE | `/api/categories[/:id]` | `{name,color,kind}` |
| GET/POST/DELETE | `/api/rules[/:id]` | `{pattern,is_regex,category_id,priority}` |
| POST | `/api/rules/apply` | re-categorize uncategorized rows |
| GET | `/api/summary/monthly?months=N` · `/api/summary/by-category?month=` · `/api/overview?month=` | dashboards |
| POST | `/api/import` · GET `/api/import/status` | re-scan the SMB folder |
