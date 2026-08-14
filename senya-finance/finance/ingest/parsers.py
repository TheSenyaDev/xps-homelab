"""Bank statement parsers + a small registry.

Adding a new bank/account = write a parser generator and `register(...)` a Source
that says how to recognize its files (by path) and which account/bank to tag.
Nothing else in the app needs to change.
"""
import csv
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Iterable

SOURCES = []


@dataclass
class Source:
    name: str                       # display/debug name
    bank: str                       # e.g. "CIBC", "TD"
    account: str                    # e.g. "CIBC Visa"
    matches: Callable[[str], bool]  # path (lowercased) -> belongs to this source?
    parse: Callable[[str], Iterable[dict]]  # file path -> rows {date,merchant,amount,direction}


def register(source: Source):
    SOURCES.append(source)
    return source


def detect(path: str):
    p = path.replace("\\", "/").lower()
    for s in SOURCES:
        if s.matches(p):
            return s
    return None


# ---- helpers ----

def _amount(x):
    x = (x or "").strip().replace("$", "").replace(",", "")
    if not x:
        return None
    try:
        return abs(float(x))
    except ValueError:
        return None


def _clean(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def _rows(path):
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        for row in csv.reader(f):
            if row and any(c.strip() for c in row):
                yield row


def _emit(date_iso, merchant, debit, credit):
    """debit = money out, credit = money in. Exactly one is expected per row."""
    if debit:
        return {"date": date_iso, "merchant": merchant, "amount": debit, "direction": "out"}
    if credit:
        return {"date": date_iso, "merchant": merchant, "amount": credit, "direction": "in"}
    return None


# Date formats seen across the exports we handle, tried in order. The bank CSVs
# above pin their own format because they have no header to disambiguate with;
# this list is for the header-driven parser, where the column is known but the
# format still varies by institution (and sometimes carries a time).
_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d", "%b %d, %Y", "%d %b %Y")


def _parse_date(raw):
    s = _clean(raw)
    if not s:
        return None
    # ISO timestamps ("2026-03-15T14:22:01Z", "2026-03-15 14:22") — keep the date.
    s = re.split(r"[T ]", s)[0] if re.match(r"^\d{4}-\d{2}-\d{2}", s) else s
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _signed_amount(x):
    """Amount keeping its sign: negative means money out. `None` if unparseable.

    Exports write negatives as `-12.34`, `(12.34)` or `12.34 CR` depending on the
    institution, so normalize all three rather than trusting a bare minus sign.
    """
    s = (x or "").strip().replace("$", "").replace(",", "").replace("−", "-")
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    s = re.sub(r"\s*(CAD|USD|CR|DR)\s*$", "", s, flags=re.I)
    try:
        v = float(s)
    except ValueError:
        return None
    return -abs(v) if neg else v


# Column aliases for the header-driven parser. Matched against the lowercased
# header cell, longest-first, so "transaction date" beats a bare "date".
_COLS = {
    "date": ("transaction date", "process date", "settlement date", "posted date", "date"),
    "description": ("description", "merchant", "payee", "details", "narrative",
                    "transaction description", "name"),
    "type": ("transaction type", "activity type", "transaction", "type", "activity"),
    "amount": ("amount", "net amount", "value", "gross amount"),
    "debit": ("debit", "withdrawal", "money out", "funds out"),
    "credit": ("credit", "deposit", "money in", "funds in"),
}


# Activity types that move money between your own holdings rather than spend it.
_INVESTMENT_ACTIVITIES = {
    "buy", "sell", "dividend", "reinvestment", "dividend reinvestment",
    "interest", "stock split", "stock dividend", "options purchase",
    "options sale", "options expiry", "options exercise", "options assignment",
}


def _map_header(header):
    """header row -> {field: column index}. Unmapped fields are simply absent."""
    cells = [_clean(h).lower() for h in header]
    found = {}
    for field, aliases in _COLS.items():
        for alias in aliases:
            for i, cell in enumerate(cells):
                if cell == alias and i not in found.values():
                    found[field] = i
                    break
            if field in found:
                break
    return found


def parse_by_header(path):
    """Parse any CSV that names its own columns, instead of pinning a layout.

    Institutions reorder and rename export columns between years — and one of
    them (Wealthsimple) has no fixed public format at all — so the header is a
    more durable contract than "column 0 is the date". Reads the first row that
    maps to at least a date and an amount, then treats the rest as data.

    Handles both shapes: a single signed `amount` column (negative = out) or
    separate debit/credit columns.
    """
    rows = _rows(path)
    cols = None
    for row in rows:
        cols = _map_header(row)
        if "date" in cols and ("amount" in cols or "debit" in cols or "credit" in cols):
            break
        cols = None
    if not cols:
        return

    def cell(row, field):
        i = cols.get(field)
        return row[i] if i is not None and i < len(row) else ""

    for row in rows:
        date_iso = _parse_date(cell(row, "date"))
        if not date_iso:
            continue  # footer/blank/subtotal line, not a transaction

        # Prefer the description; fall back to the activity type so a row is
        # never labelled with an empty string (Wealthsimple leaves the
        # description blank on deposits and dividends).
        kind = _clean(cell(row, "type"))
        merchant = _clean(cell(row, "description")) or kind or "—"
        # A security trade describes itself by ticker ("AAPL"), which on its own
        # looks exactly like a merchant and would be counted as spending. Prefix
        # those with the activity so the default rules can route them to
        # Investments — but only those, so ordinary purchases keep clean
        # merchant names for the recurring detector to group on.
        if kind and kind.lower() in _INVESTMENT_ACTIVITIES and not merchant.lower().startswith(kind.lower()):
            merchant = f"{kind} {merchant}"

        if "amount" in cols:
            amt = _signed_amount(cell(row, "amount"))
            if amt is None or amt == 0:
                continue
            tx = _emit(date_iso, merchant, abs(amt) if amt < 0 else None,
                       abs(amt) if amt > 0 else None)
        else:
            tx = _emit(date_iso, merchant, _amount(cell(row, "debit")), _amount(cell(row, "credit")))
        if tx:
            yield tx


# ---- parsers ----

def parse_cibc(path):
    """CIBC: date(YYYY-MM-DD), description, debit, credit[, card]. Merchant may be
    quoted (commas inside) — csv handles that."""
    for row in _rows(path):
        if len(row) < 4:
            continue
        try:
            d = datetime.strptime(row[0].strip(), "%Y-%m-%d").date().isoformat()
        except ValueError:
            continue
        tx = _emit(d, _clean(row[1]), _amount(row[2]), _amount(row[3]))
        if tx:
            yield tx


def parse_td_visa(path):
    """TD Visa: date(MM/DD/YYYY), merchant, debit, credit, balance."""
    for row in _rows(path):
        if len(row) < 4:
            continue
        try:
            d = datetime.strptime(row[0].strip(), "%m/%d/%Y").date().isoformat()
        except ValueError:
            continue
        tx = _emit(d, _clean(row[1]), _amount(row[2]), _amount(row[3]))
        if tx:
            yield tx


# ---- registry (order matters: first match wins) ----

register(Source("CIBC Mastercard", "CIBC", "CIBC Mastercard",
                lambda p: "cibc" in p and "mastercard" in p, parse_cibc))
register(Source("CIBC Visa", "CIBC", "CIBC Visa",
                lambda p: "cibc" in p and "visa" in p, parse_cibc))
register(Source("CIBC Chequing", "CIBC", "CIBC Chequing",
                lambda p: "cibc" in p and ("cheq" in p or "chequ" in p), parse_cibc))
register(Source("TD Visa", "TD", "TD Visa",
                lambda p: ("td bank" in p or "/td/" in p) and "visa" in p, parse_td_visa))

# Wealthsimple has no public API and no fixed export layout — the activities CSV
# is generated per account type and its columns have changed more than once — so
# these go through the header-driven parser rather than a pinned column order.
# Registered per account so a Cash card charge and an RRSP contribution don't
# land in the same bucket; the generic entry last catches anything else.
# Drop the exports anywhere under the import dir with the account in the
# filename, e.g. `wealthsimple-cash-2026.csv`.
def _ws(*keywords):
    return lambda p: "wealthsimple" in p and any(k in p for k in keywords)


register(Source("Wealthsimple Cash", "Wealthsimple", "Wealthsimple Cash",
                _ws("cash", "spend"), parse_by_header))
register(Source("Wealthsimple TFSA", "Wealthsimple", "Wealthsimple TFSA",
                _ws("tfsa"), parse_by_header))
register(Source("Wealthsimple RRSP", "Wealthsimple", "Wealthsimple RRSP",
                _ws("rrsp"), parse_by_header))
register(Source("Wealthsimple FHSA", "Wealthsimple", "Wealthsimple FHSA",
                _ws("fhsa"), parse_by_header))
register(Source("Wealthsimple Crypto", "Wealthsimple", "Wealthsimple Crypto",
                _ws("crypto"), parse_by_header))
register(Source("Wealthsimple Trade", "Wealthsimple", "Wealthsimple Trade",
                lambda p: "wealthsimple" in p, parse_by_header))
