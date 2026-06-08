"""Aggregations for dashboards. Spending = money out that isn't a transfer or
already labeled income (uncategorized out counts as spending). Income = money in
labeled with an income-kind category."""
from flask import Blueprint, jsonify, request

from ..db import get_db

bp = Blueprint("summary", __name__, url_prefix="/api")

# Reusable SQL fragments.
_IS_SPENDING = "t.direction = 'out' AND (t.category_id IS NULL OR c.kind = 'expense')"
_IS_INCOME = "t.direction = 'in' AND c.kind = 'income'"
_JOIN = "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id"


@bp.get("/summary/months")
def months():
    rows = get_db().execute("SELECT DISTINCT month FROM transactions ORDER BY month DESC").fetchall()
    return jsonify([r["month"] for r in rows])


@bp.get("/summary/monthly")
def monthly():
    limit = min(int(request.args.get("months", 12)), 120)
    rows = get_db().execute(
        f"SELECT t.month, "
        f"SUM(CASE WHEN {_IS_SPENDING} THEN t.amount ELSE 0 END) AS spending, "
        f"SUM(CASE WHEN {_IS_INCOME} THEN t.amount ELSE 0 END) AS income "
        f"{_JOIN} GROUP BY t.month ORDER BY t.month DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return jsonify([dict(r) for r in rows][::-1])  # chronological


def _by_category(db, month):
    return [dict(r) for r in db.execute(
        f"SELECT COALESCE(c.name, 'Uncategorized') AS category, "
        f"COALESCE(c.color, '#8b91a1') AS color, c.id AS category_id, "
        f"SUM(t.amount) AS amount, COUNT(*) AS tx_count "
        f"{_JOIN} WHERE {_IS_SPENDING} AND t.month = ? "
        f"GROUP BY t.category_id ORDER BY amount DESC",
        (month,),
    ).fetchall()]


@bp.get("/summary/by-category")
def by_category():
    month = request.args.get("month")
    if not month:
        return jsonify({"error": "month required"}), 400
    return jsonify(_by_category(get_db(), month))


@bp.get("/overview")
def overview():
    db = get_db()
    month = request.args.get("month")
    if not month:
        row = db.execute("SELECT month FROM transactions ORDER BY month DESC LIMIT 1").fetchone()
        month = row["month"] if row else None
    if not month:
        return jsonify({"month": None, "spending": 0, "income": 0, "uncategorized": 0,
                        "by_category": [], "top_merchants": []})

    totals = db.execute(
        f"SELECT SUM(CASE WHEN {_IS_SPENDING} THEN t.amount ELSE 0 END) AS spending, "
        f"SUM(CASE WHEN {_IS_INCOME} THEN t.amount ELSE 0 END) AS income "
        f"{_JOIN} WHERE t.month = ?", (month,),
    ).fetchone()
    uncategorized = db.execute(
        "SELECT COUNT(*) FROM transactions WHERE month = ? AND direction = 'out' AND category_id IS NULL",
        (month,),
    ).fetchone()[0]
    top_merchants = [dict(r) for r in db.execute(
        f"SELECT t.merchant, SUM(t.amount) AS amount, COUNT(*) AS tx_count "
        f"{_JOIN} WHERE {_IS_SPENDING} AND t.month = ? "
        f"GROUP BY t.merchant ORDER BY amount DESC LIMIT 8", (month,),
    ).fetchall()]

    return jsonify({
        "month": month,
        "spending": totals["spending"] or 0,
        "income": totals["income"] or 0,
        "uncategorized": uncategorized,
        "by_category": _by_category(db, month),
        "top_merchants": top_merchants,
    })
