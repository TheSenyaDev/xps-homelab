"""Derived observations about a month — the "so what" the dashboard totals don't say.

Everything here is computed from the same `spending.py` definition the other
aggregations use, so the numbers can't disagree with the dashboard. Each block
answers one question a total can't: is this month worse than usual, what moved,
where is it heading, and what showed up that never had before.
"""
import calendar
from datetime import date

from flask import Blueprint, jsonify, request

from ..db import get_db
from ..spending import IS_INCOME, IS_SPENDING, JOIN

bp = Blueprint("insights", __name__, url_prefix="/api")

# A merchant counts as "new" if it doesn't appear in this many months of history
# before the selected one. Long enough that a quarterly or seasonal charge isn't
# announced as new every time it comes round.
NEW_MERCHANT_LOOKBACK = 12
# How many months feed the "usual" baseline the current month is compared to.
BASELINE_MONTHS = 6


def _shift_month(month, delta):
    y, m = (int(x) for x in month.split("-"))
    total = y * 12 + (m - 1) + delta
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def _month_totals(db, month):
    row = db.execute(
        f"SELECT SUM(CASE WHEN {IS_SPENDING} THEN t.amount ELSE 0 END) AS spending, "
        f"SUM(CASE WHEN {IS_INCOME} THEN t.amount ELSE 0 END) AS income "
        f"{JOIN} WHERE t.month = ?", (month,),
    ).fetchone()
    return {"spending": round(row["spending"] or 0, 2), "income": round(row["income"] or 0, 2)}


def _pct_change(now, before):
    """Percent change, or None when there's no baseline to divide by."""
    if not before:
        return None
    return round((now - before) / before * 100, 1)


@bp.get("/insights")
def insights():
    db = get_db()
    month = request.args.get("month")
    if not month:
        row = db.execute("SELECT month FROM transactions ORDER BY month DESC LIMIT 1").fetchone()
        month = row["month"] if row else None
    if not month:
        return jsonify({"month": None})

    cur = _month_totals(db, month)
    prev = _month_totals(db, _shift_month(month, -1))

    # Baseline: the months before this one, so a month can be compared to "usual"
    # rather than only to whatever last month happened to be.
    baseline_rows = db.execute(
        f"SELECT t.month, SUM(CASE WHEN {IS_SPENDING} THEN t.amount ELSE 0 END) AS spending "
        f"{JOIN} WHERE t.month < ? GROUP BY t.month ORDER BY t.month DESC LIMIT ?",
        (month, BASELINE_MONTHS),
    ).fetchall()
    baseline = round(sum(r["spending"] for r in baseline_rows) / len(baseline_rows), 2) if baseline_rows else None

    return jsonify({
        "month": month,
        "spending": cur["spending"],
        "income": cur["income"],
        "prev_spending": prev["spending"],
        "prev_income": prev["income"],
        "spending_change_pct": _pct_change(cur["spending"], prev["spending"]),
        "baseline_spending": baseline,
        "vs_baseline_pct": _pct_change(cur["spending"], baseline) if baseline else None,
        # Share of income kept. Negative means the month spent more than it earned.
        "savings_rate": (round((cur["income"] - cur["spending"]) / cur["income"] * 100, 1)
                         if cur["income"] > 0 else None),
        "projection": _projection(db, month, cur["spending"]),
        "movers": _movers(db, month),
        "largest": _largest(db, month),
        "new_merchants": _new_merchants(db, month),
        "daily": _daily(db, month),
        "by_account": _by_account(db, month),
    })


def _projection(db, month, spent_so_far):
    """Where this month lands if the rest of it looks like the part already spent.

    Only meaningful for the month actually in progress: for a finished month the
    projection *is* the total, and saying "projected" about a closed month reads
    as though more is still coming.
    """
    year, mon = (int(x) for x in month.split("-"))
    today = date.today()
    if (year, mon) != (today.year, today.month):
        return None
    days_in_month = calendar.monthrange(year, mon)[1]
    elapsed = today.day
    if elapsed < 3:
        return None  # two days of data extrapolated over a month is noise, not a forecast
    return {
        "projected": round(spent_so_far / elapsed * days_in_month, 2),
        "per_day": round(spent_so_far / elapsed, 2),
        "days_elapsed": elapsed,
        "days_in_month": days_in_month,
    }


def _movers(db, month, limit=6):
    """Categories that changed most against last month, by dollar amount.

    Ranked by absolute dollars rather than percent: a 300% rise on a $4 category
    is arithmetic, not news, while +$300 on groceries is the thing worth seeing.
    """
    prev_month = _shift_month(month, -1)

    def totals(m):
        return {r["category"]: dict(r) for r in db.execute(
            f"SELECT COALESCE(c.name, 'Uncategorized') AS category, "
            f"COALESCE(c.color, '#8b91a1') AS color, c.id AS category_id, "
            f"SUM(t.amount) AS amount "
            f"{JOIN} WHERE {IS_SPENDING} AND t.month = ? GROUP BY t.category_id", (m,),
        ).fetchall()}

    cur, prev = totals(month), totals(prev_month)
    out = []
    for name in set(cur) | set(prev):
        now = round(cur.get(name, {}).get("amount", 0) or 0, 2)
        before = round(prev.get(name, {}).get("amount", 0) or 0, 2)
        if now == before:
            continue
        meta = cur.get(name) or prev.get(name)
        out.append({
            "category": name,
            "category_id": meta.get("category_id"),
            "color": meta.get("color"),
            "amount": now,
            "prev_amount": before,
            "delta": round(now - before, 2),
            "change_pct": _pct_change(now, before),
        })
    out.sort(key=lambda r: -abs(r["delta"]))
    return out[:limit]


def _largest(db, month, limit=5):
    rows = db.execute(
        f"SELECT t.id, t.date, t.merchant, t.amount, t.account, "
        f"COALESCE(c.name, 'Uncategorized') AS category, COALESCE(c.color, '#8b91a1') AS color "
        f"{JOIN} WHERE {IS_SPENDING} AND t.month = ? ORDER BY t.amount DESC LIMIT ?",
        (month, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def _new_merchants(db, month, limit=6):
    """Merchants charged this month that don't appear in the preceding year.

    Useful as a soft fraud/forgotten-signup check — a charge from somewhere you
    have never shopped is worth a glance even when the amount is small.
    """
    since = _shift_month(month, -NEW_MERCHANT_LOOKBACK)
    rows = db.execute(
        f"SELECT t.merchant, SUM(t.amount) AS amount, COUNT(*) AS tx_count "
        f"{JOIN} WHERE {IS_SPENDING} AND t.month = ? AND t.merchant NOT IN ("
        f"  SELECT merchant FROM transactions WHERE month < ? AND month >= ?"
        f") GROUP BY t.merchant ORDER BY amount DESC LIMIT ?",
        (month, month, since, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def _daily(db, month):
    """Every day of the month with its spend — including the zero-spend days.

    The gaps are the signal (a quiet week vs a heavy one), so days with no
    transactions are filled in rather than skipped, which would otherwise
    squeeze the chart and misrepresent the shape of the month.
    """
    rows = {r["date"]: r["amount"] for r in db.execute(
        f"SELECT t.date, SUM(t.amount) AS amount {JOIN} "
        f"WHERE {IS_SPENDING} AND t.month = ? GROUP BY t.date", (month,),
    ).fetchall()}
    year, mon = (int(x) for x in month.split("-"))
    days_in_month = calendar.monthrange(year, mon)[1]
    return [{"date": f"{month}-{d:02d}", "amount": round(rows.get(f"{month}-{d:02d}", 0), 2)}
            for d in range(1, days_in_month + 1)]


def _by_account(db, month):
    rows = db.execute(
        f"SELECT t.account, SUM(t.amount) AS amount, COUNT(*) AS tx_count "
        f"{JOIN} WHERE {IS_SPENDING} AND t.month = ? GROUP BY t.account ORDER BY amount DESC",
        (month,),
    ).fetchall()
    return [dict(r) for r in rows]
