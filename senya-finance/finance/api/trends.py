"""Long-range views. The dashboard answers "this month"; this answers "is it
getting worse?" — which needs a year at a time and something to compare against.
"""
from flask import Blueprint, jsonify, request

from ..db import get_db
from ..spending import IS_INCOME, IS_SPENDING, JOIN

bp = Blueprint("trends", __name__, url_prefix="/api/trends")


@bp.get("/years")
def years():
    """Spending, income and net for every year on record."""
    rows = get_db().execute(
        f"SELECT substr(t.month, 1, 4) AS year, "
        f"SUM(CASE WHEN {IS_SPENDING} THEN t.amount ELSE 0 END) AS spending, "
        f"SUM(CASE WHEN {IS_INCOME} THEN t.amount ELSE 0 END) AS income, "
        f"COUNT(*) AS tx_count "
        f"{JOIN} GROUP BY year ORDER BY year DESC"
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["net"] = round((d["income"] or 0) - (d["spending"] or 0), 2)
        out.append(d)
    return jsonify(out)


@bp.get("/monthly")
def monthly():
    """The 12 months of `year`, alongside the same months a year earlier.

    Always 12 rows, including months with no transactions — a gap in the middle
    of a bar chart should read as a zero, not close the gap and misalign the
    comparison against the previous year.
    """
    year = request.args.get("year")
    if not year:
        row = get_db().execute("SELECT substr(month, 1, 4) y FROM transactions "
                               "ORDER BY month DESC LIMIT 1").fetchone()
        year = row["y"] if row else None
    if not year:
        return jsonify({"year": None, "months": []})

    def totals(y):
        rows = get_db().execute(
            f"SELECT t.month, "
            f"SUM(CASE WHEN {IS_SPENDING} THEN t.amount ELSE 0 END) AS spending, "
            f"SUM(CASE WHEN {IS_INCOME} THEN t.amount ELSE 0 END) AS income "
            f"{JOIN} WHERE substr(t.month, 1, 4) = ? GROUP BY t.month",
            (str(y),),
        ).fetchall()
        return {r["month"][5:]: r for r in rows}

    this_year, last_year = totals(year), totals(int(year) - 1)
    months = []
    for m in range(1, 13):
        key = f"{m:02d}"
        cur, prev = this_year.get(key), last_year.get(key)
        months.append({
            "month": f"{year}-{key}",
            "spending": round(cur["spending"], 2) if cur else 0,
            "income": round(cur["income"], 2) if cur else 0,
            "prev_spending": round(prev["spending"], 2) if prev else 0,
        })
    return jsonify({"year": str(year), "months": months})


@bp.get("/by-category")
def by_category():
    """Category totals for `year`, with the change against the year before.

    The comparison is the point: a category that doubled is worth seeing even
    when it isn't one of the biggest, so `change_pct` is reported per row rather
    than left for the client to work out.
    """
    year = request.args.get("year")
    if not year:
        row = get_db().execute("SELECT substr(month, 1, 4) y FROM transactions "
                               "ORDER BY month DESC LIMIT 1").fetchone()
        year = row["y"] if row else None
    if not year:
        return jsonify([])

    def totals(y):
        rows = get_db().execute(
            f"SELECT COALESCE(c.name, 'Uncategorized') AS category, "
            f"COALESCE(c.color, '#8b91a1') AS color, c.id AS category_id, "
            f"SUM(t.amount) AS amount, COUNT(*) AS tx_count "
            f"{JOIN} WHERE {IS_SPENDING} AND substr(t.month, 1, 4) = ? "
            f"GROUP BY t.category_id",
            (str(y),),
        ).fetchall()
        return {r["category"]: dict(r) for r in rows}

    cur, prev = totals(year), totals(int(year) - 1)
    out = []
    for name, row in cur.items():
        before = prev.get(name, {}).get("amount", 0) or 0
        row["prev_amount"] = round(before, 2)
        row["amount"] = round(row["amount"], 2)
        # No previous spend means there's no percentage to report — "new this
        # year" is the honest answer, and dividing by zero isn't.
        row["change_pct"] = (round((row["amount"] - before) / before * 100, 1)
                             if before > 0 else None)
        out.append(row)
    out.sort(key=lambda r: -r["amount"])
    return jsonify({"year": str(year), "categories": out})
