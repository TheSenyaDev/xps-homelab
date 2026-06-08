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
