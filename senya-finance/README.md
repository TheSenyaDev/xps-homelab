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
    trends.py · recurring.py · budgets.py · insights.py · merchants.py
  static/               ES-module frontend
    charts.js           donut · sparkline · bars · progress (DOM + CSS, no lib)
    views/              dashboard · budgets · trends · recurring · merchants ·
                        transactions · categories
tests/                  pytest suite for the pure logic
```

### Data model
- **transactions** — `date, month, merchant, amount, direction(out/in), account, bank, category_id, hash`
- **categories** — `name, color, kind(expense|income|transfer)`
- **rules** — `pattern, is_regex, category_id, priority` (first match wins)
- **budgets** — `category_id, amount` — one standing monthly budget per category

`spending` = money **out** that's uncategorized or in an *expense* category
(transfers/income excluded, so credit-card payments don't double-count). The SQL
for this lives in `spending.py` and is imported by every aggregation, so two
screens can't drift into reporting different totals for the same month.

## Views

- **Dashboard** — one month: totals with a 12-month sparkline, an insight strip
  (projected month-end, how it compares to your 6-month usual, the category that
  moved most, merchants never seen before), a category donut, top merchants,
  budget progress, spend per day, and the biggest charges.
- **Budgets** — a monthly ceiling per category and how the month is tracking,
  including a pace marker: where even spending would have you *today*, so 60%
  used on the 12th reads as a problem and on the 25th doesn't. Unbudgeted
  categories are listed with a suggestion (your median of the last 6 months).
- **Trends** — one *year*, against the year before it: monthly bars with last
  year behind them, and a category table showing what grew and by how much.
- **Subscriptions** — recurring charges found in the history, what they cost per
  month and per year, when each is next due, and which ones went up in price.
- **Merchants** — the same money ranked by where it went rather than by
  category, over a month, a year, or all time.
- **Transactions** — filter, categorize (one row or many at once), make rules,
  export the current filter as CSV.
- **Categories & Rules** — the vocabulary, the rules, and suggested rules.

Clicking any merchant — in a chart, a table, or the subscriptions list — opens a
drill-down with its lifetime total, per-charge average, month-by-month history
and every transaction, without leaving the view you were on.

The interface follows the OS light/dark preference on first load and remembers
the toggle after that.

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
CIBC Mastercard/Visa/Chequing, TD Visa, Wealthsimple (Cash, TFSA, RRSP, FHSA,
Crypto, Trade). (TD chequing is PDF-only — not yet parsed.)

### Wealthsimple

**There is no Wealthsimple API to connect to.** They publish no developer API
for personal accounts, so nothing here logs in on your behalf. The options and
why this one:

| Route | Verdict |
|---|---|
| **Activities CSV export** (used here) | Works today, no credentials stored, no ToS question. Manual re-export. |
| Unofficial GraphQL libraries (`ws-api`, `wsimple`) | Reverse-engineered. Wants your Wealthsimple email, password and 2FA code stored in the homelab, and breaks whenever they change the private API. Not worth it for read-only spending data. |
| Aggregators (SnapTrade, Plaid) | The supported programmatic route, but they're commercial services needing business signup and an account-linking flow — a lot of moving parts, and a third party holding your bank credentials. |

So: export and drop the file in. In Wealthsimple **on the web** (not the app),
open the account → **Activity** → export as CSV, and save it under the import
folder with the account in the filename:

```
wealthsimple-cash-2026.csv     -> Wealthsimple Cash
wealthsimple-tfsa-2026.csv     -> Wealthsimple TFSA
wealthsimple-rrsp-2026.csv     -> Wealthsimple RRSP
wealthsimple-anything.csv      -> Wealthsimple Trade (fallback)
```

Re-exporting the whole history each time is fine — the importer dedupes, so only
genuinely new rows are added.

Two things the parser handles that are specific to these files:

- **Wealthsimple's CSV layout isn't fixed** (no published format, and the columns
  have changed), so it's read by *header name* rather than column position —
  `parse_by_header` in `ingest/parsers.py`, which also accepts either a single
  signed `amount` column or separate debit/credit columns.
- **Investment activity is not spending.** A trade names itself by ticker, and on
  its own `AAPL` looks exactly like a shop — a $500 stock purchase would land in
  your spending total. Those rows are prefixed with the activity (`Buy AAPL`) so
  the default rules route them to **Investments**, and funding rows (`Deposit`,
  `Contribution`, `Transfer in`) route to **Transfer**. Both kinds are excluded
  from spending *and* income, because the money is already counted on the bank
  account it came from — the same reason a credit-card payment is excluded.

If you use Wealthsimple Cash as a chequing account and want a deposit into it
counted as income, edit that default rule (Categories & Rules → the
`^(DEPOSIT|WITHDRAWAL|…)` rule) rather than deleting it — defaults come back on
restart.

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
| GET | `/api/budgets?month=` | every expense category with budget, spend, pace and a suggestion |
| PUT | `/api/budgets/:category_id` | `{amount}` — 0 or null removes the budget |
| GET | `/api/insights?month=` | projection, vs-baseline, category movers, biggest charges, new merchants, spend per day, per account |
| GET | `/api/merchants?month=&year=&limit=` · `/api/merchants/detail?name=` | ranked merchants · one merchant's full history |
| GET | `/api/export/transactions.csv` | the transaction filters, as a download |
| POST | `/api/import` · GET `/api/import/status` | re-scan the SMB folder |

## Tests

```bash
docker run --rm -v "$PWD:/app" -w /app senya-finance:latest \
  sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
```

Covers the pieces with enough judgement in them to be worth pinning down:

- **the recurring detector** — cadence fitting, outlier amounts, what "active" means;
- **the header-driven parser** — which column names mean what, how a negative is
  written (`-5`, `(5)`, `5 CR`), which rows are transactions at all, and keeping
  security trades out of the spending total. Wealthsimple has no published
  format, so this pins the behaviour rather than one sample file;
- **month arithmetic** — the budget pace marker and every month-over-month
  comparison, which are silently wrong (not loud) at year boundaries and in
  February if the maths slips.
