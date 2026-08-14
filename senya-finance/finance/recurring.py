"""Recurring-charge detection: find the things that bill you again and again.

Pure functions over a list of transaction dicts, so the API layer can hand in a
query result and tests can hand in fixtures.

The approach is deliberately statistical rather than rule-based: a subscription
is "same merchant, similar amount, evenly spaced", and that shape holds whether
it's Netflix, a gym, insurance or a car loan — no per-merchant list to maintain.
"""
import re
import statistics
from datetime import date, timedelta

# (label, days, tolerance) — tolerance is how far a gap can drift and still count.
# Monthly gets a wide one because month lengths differ by up to 3 days and
# billing lands on the next business day when the due date is a weekend.
CADENCES = [
    ("weekly", 7, 2),
    ("biweekly", 14, 3),
    ("monthly", 30.4, 6),
    ("quarterly", 91.3, 12),
    ("yearly", 365.2, 30),
]

MIN_OCCURRENCES = 3          # two points make a line; three make a pattern
AMOUNT_TOLERANCE = 0.35      # ±35% around the median still counts as "same charge"
PRICE_HIKE_THRESHOLD = 0.10  # flag an increase once it clears 10%

# Bank descriptors carry per-transaction noise: reference numbers, store numbers,
# terminal ids. Strip them so "SQ *FAST FRESH FOODS 4471" and "... 8813" are seen
# as one merchant rather than two one-offs.
_NOISE = [
    (re.compile(r"\b\d{6,}\b"), " "),                 # long reference numbers
    (re.compile(r"#\s*\d+"), " "),                    # #0623 store numbers
    (re.compile(r"\b\d+\.\d{2}\s*[A-Z]{3}\s*@\s*[\d.]+"), " "),  # FX "6990.00 THB @ .04"
    (re.compile(r"\s+"), " "),
]


def normalize_merchant(merchant):
    """Collapse a bank descriptor to something stable across months."""
    out = (merchant or "").upper()
    for pattern, repl in _NOISE:
        out = pattern.sub(repl, out)
    return out.strip(" -*")


def _parse(d):
    return date.fromisoformat(d[:10])


def _classify_cadence(gaps):
    """Best-fitting cadence for a list of day-gaps, or None if nothing fits.

    Uses the median gap so one skipped or double-billed month doesn't drag the
    classification off; then requires most individual gaps to sit near it, which
    is what separates a real subscription from a merchant you happen to visit a
    lot.
    """
    if not gaps:
        return None, 0.0
    median = statistics.median(gaps)
    for label, days, tol in CADENCES:
        if abs(median - days) <= tol:
            close = sum(1 for g in gaps if abs(g - days) <= tol * 1.8)
            if close / len(gaps) >= 0.6:
                return label, median
    return None, median


def as_of_date(transactions):
    """The newest transaction date — what "now" means to this dataset.

    Deliberately not `date.today()`: the app only knows what has been imported,
    and statements arrive in batches. Judged against the wall clock, every
    subscription looks cancelled for however long it's been since the last
    import, which is exactly backwards.
    """
    dates = [t["date"][:10] for t in transactions if t.get("date")]
    return _parse(max(dates)) if dates else date.today()


def detect(transactions, today=None):
    """Group `transactions` into recurring series.

    Each result describes one merchant billing on one cadence: how much, how
    often, when it last hit, when it's next expected, and whether the amount has
    gone up since it started.

    `today` defaults to the newest transaction in `transactions` (see
    `as_of_date`), so "still active?" is answered relative to the data.
    """
    today = today or as_of_date(transactions)

    groups = {}
    for t in transactions:
        if t["direction"] != "out":
            continue  # a recurring charge is money leaving
        groups.setdefault(normalize_merchant(t["merchant"]), []).append(t)

    series = []
    for key, txs in groups.items():
        if len(txs) < MIN_OCCURRENCES:
            continue
        txs.sort(key=lambda t: t["date"])

        # Outliers in amount are usually a different product from the same
        # merchant (a one-off Amazon order next to a monthly subscription), so
        # judge the cadence on the charges that cluster around the median.
        amounts = [t["amount"] for t in txs]
        median_amount = statistics.median(amounts)
        if median_amount <= 0:
            continue
        core = [t for t in txs
                if abs(t["amount"] - median_amount) <= median_amount * AMOUNT_TOLERANCE]
        if len(core) < MIN_OCCURRENCES:
            continue

        dates = [_parse(t["date"]) for t in core]
        gaps = [(b - a).days for a, b in zip(dates, dates[1:]) if (b - a).days > 0]
        cadence, median_gap = _classify_cadence(gaps)
        if cadence is None:
            continue

        core_amounts = [t["amount"] for t in core]
        typical = round(statistics.median(core_amounts), 2)
        last_seen = dates[-1]
        next_due = last_seen + timedelta(days=round(median_gap))

        # "Still running?" — allow a full extra cycle plus a week of slack before
        # calling it cancelled, so a late bill isn't reported as gone.
        overdue_by = (today - next_due).days
        active = overdue_by <= round(median_gap) + 7

        # Compare the most recent charge against the earlier ones rather than the
        # overall median, which the new price would itself drag upward.
        hike = None
        if len(core_amounts) >= 4:
            earlier = statistics.median(core_amounts[:-2])
            latest = core_amounts[-1]
            if earlier > 0 and (latest - earlier) / earlier >= PRICE_HIKE_THRESHOLD:
                hike = {
                    "from": round(earlier, 2),
                    "to": round(latest, 2),
                    "percent": round((latest - earlier) / earlier * 100, 1),
                }

        per_month = typical * (30.4 / median_gap) if median_gap else 0
        series.append({
            "merchant": key,
            "display": max((t["merchant"] for t in core), key=len),
            "cadence": cadence,
            "typical_amount": typical,
            "monthly_equivalent": round(per_month, 2),
            "yearly_equivalent": round(per_month * 12, 2),
            "occurrences": len(core),
            "first_seen": dates[0].isoformat(),
            "last_seen": last_seen.isoformat(),
            "next_due": next_due.isoformat(),
            "active": active,
            "days_overdue": max(overdue_by, 0),
            "category": core[-1].get("category"),
            "category_id": core[-1].get("category_id"),
            "category_color": core[-1].get("category_color"),
            "account": core[-1].get("account"),
            "price_change": hike,
        })

    series.sort(key=lambda s: (not s["active"], -s["monthly_equivalent"]))
    return series


def summarize(series):
    """Headline numbers for the active subscriptions."""
    active = [s for s in series if s["active"]]
    return {
        "active_count": len(active),
        "inactive_count": len(series) - len(active),
        "monthly_total": round(sum(s["monthly_equivalent"] for s in active), 2),
        "yearly_total": round(sum(s["yearly_equivalent"] for s in active), 2),
        "price_increases": [s for s in active if s["price_change"]],
    }
