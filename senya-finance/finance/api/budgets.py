"""Monthly budgets per category, and how the selected month is tracking.

A budget is one number per category (see the table comment in db.py). The
interesting part is the read side: a bare "spent 412 of 600" is only useful
partway through a month if you also know whether that's ahead of or behind
pace, so every row carries the same month's `pace` — what you'd have spent by
today if you were spending evenly.
"""
import calendar
from datetime import date

from flask import Blueprint, jsonify, request

from ..db import get_db
from ..spending import IS_SPENDING, JOIN

bp = Blueprint("budgets", __name__, url_prefix="/api")

# How much history a suggestion looks at. Six months is long enough to average
# out a heavy month and short enough to still reflect current prices.
SUGGEST_MONTHS = 6


def _month_progress(month):
    """(days_elapsed, days_in_month) for `month`.

    A month that has already ended counts as fully elapsed — otherwise every
    past month would look like it was tracking under budget forever.
    """
    year, mon = (int(x) for x in month.split("-"))
    days_in_month = calendar.monthrange(year, mon)[1]
    today = date.today()
    if (year, mon) < (today.year, today.month):
        return days_in_month, days_in_month
    if (year, mon) > (today.year, today.month):
        return 0, days_in_month
    return today.day, days_in_month


def _spent_by_category(db, month):
    return {r["category_id"]: dict(r) for r in db.execute(
        f"SELECT t.category_id, SUM(t.amount) AS spent, COUNT(*) AS tx_count "
        f"{JOIN} WHERE {IS_SPENDING} AND t.month = ? AND t.category_id IS NOT NULL "
        f"GROUP BY t.category_id", (month,),
    ).fetchall()}


@bp.get("/budgets")
def list_budgets():
    """Every expense category, budgeted or not, with this month's progress.

    Returns unbudgeted categories too (`amount: null`) so the UI can offer to
    set one without a second request — and so a category you spend in but never
    budgeted is visible rather than silently missing from the page.
    """
    db = get_db()
    month = request.args.get("month")
    if not month:
        row = db.execute("SELECT month FROM transactions ORDER BY month DESC LIMIT 1").fetchone()
        month = row["month"] if row else None
    if not month:
        return jsonify({"month": None, "budgets": [], "totals": {}})

    elapsed, days = _month_progress(month)
    spent_by_cat = _spent_by_category(db, month)
    budgets = {r["category_id"]: r["amount"] for r in db.execute("SELECT * FROM budgets").fetchall()}
    suggestions = _suggestions(db, month)

    rows = []
    for c in db.execute("SELECT id, name, color FROM categories WHERE kind = 'expense' ORDER BY name"):
        spent = round(spent_by_cat.get(c["id"], {}).get("spent", 0) or 0, 2)
        amount = budgets.get(c["id"])
        rows.append({
            "category_id": c["id"], "category": c["name"], "color": c["color"],
            "amount": amount,
            "spent": spent,
            "tx_count": spent_by_cat.get(c["id"], {}).get("tx_count", 0),
            "remaining": round(amount - spent, 2) if amount else None,
            "pct": round(spent / amount * 100) if amount else None,
            # Even pace to date. The UI compares `spent` against this to say
            # "on track" vs "over pace" while the month is still running.
            "pace": round(amount * elapsed / days, 2) if amount and days else None,
            "suggested": suggestions.get(c["id"]),
        })

    budgeted = [r for r in rows if r["amount"]]
    total_budget = round(sum(r["amount"] for r in budgeted), 2)
    total_spent = round(sum(r["spent"] for r in budgeted), 2)
    return jsonify({
        "month": month,
        "days_elapsed": elapsed,
        "days_in_month": days,
        "budgets": rows,
        "totals": {
            "budget": total_budget,
            "spent": total_spent,
            "remaining": round(total_budget - total_spent, 2),
            "pct": round(total_spent / total_budget * 100) if total_budget else None,
            "over_count": sum(1 for r in budgeted if r["spent"] > r["amount"]),
            # Spending outside any budget, so the totals can't quietly imply
            # you're under when the uncovered categories are where it went.
            "unbudgeted_spent": round(
                sum(r["spent"] for r in rows if not r["amount"]), 2),
        },
    })


def _suggestions(db, month):
    """Median monthly spend per category over the months *before* `month`.

    Median rather than mean: one holiday month or an annual insurance payment
    would drag an average up and suggest a budget nobody would ever hit.
    """
    rows = db.execute(
        f"SELECT t.category_id, t.month, SUM(t.amount) AS amount "
        f"{JOIN} WHERE {IS_SPENDING} AND t.category_id IS NOT NULL AND t.month < ? "
        f"GROUP BY t.category_id, t.month ORDER BY t.month DESC", (month,),
    ).fetchall()
    per_cat = {}
    for r in rows:
        per_cat.setdefault(r["category_id"], [])
        if len(per_cat[r["category_id"]]) < SUGGEST_MONTHS:
            per_cat[r["category_id"]].append(r["amount"])
    out = {}
    for cid, amounts in per_cat.items():
        if len(amounts) < 2:
            continue  # one month of history isn't a pattern
        amounts.sort()
        mid = len(amounts) // 2
        median = amounts[mid] if len(amounts) % 2 else (amounts[mid - 1] + amounts[mid]) / 2
        out[cid] = round(median, 2)
    return out


@bp.put("/budgets/<int:category_id>")
def set_budget(category_id):
    """Set (or clear) a category's monthly budget. `{amount}`; 0 or null clears."""
    data = request.get_json(force=True) or {}
    raw = data.get("amount")
    db = get_db()
    if db.execute("SELECT 1 FROM categories WHERE id = ?", (category_id,)).fetchone() is None:
        return jsonify({"error": "unknown category"}), 404

    if raw in (None, "", 0):
        db.execute("DELETE FROM budgets WHERE category_id = ?", (category_id,))
        db.commit()
        return jsonify({"category_id": category_id, "amount": None})
    try:
        amount = round(float(raw), 2)
    except (TypeError, ValueError):
        return jsonify({"error": "amount must be a number"}), 400
    if amount < 0:
        return jsonify({"error": "amount must be positive"}), 400

    db.execute(
        "INSERT INTO budgets (category_id, amount) VALUES (?, ?) "
        "ON CONFLICT(category_id) DO UPDATE SET amount = excluded.amount, "
        "updated_at = datetime('now')",
        (category_id, amount),
    )
    db.commit()
    return jsonify({"category_id": category_id, "amount": amount})
