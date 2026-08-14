"""Per-merchant history, and a CSV export of whatever you're looking at.

The merchant name arrives as a query parameter rather than a path segment on
purpose: bank descriptors contain slashes, `#` and `?` (`SQ *SHOP #123/A`), all
of which either break routing or get silently mangled inside a path.
"""
import csv
import io

from flask import Blueprint, Response, jsonify, request

from ..db import get_db
from ..spending import IS_SPENDING, JOIN

bp = Blueprint("merchants", __name__, url_prefix="/api")


@bp.get("/merchants")
def top_merchants():
    """Biggest merchants over a month, a year, or all of history."""
    db = get_db()
    where, params = [IS_SPENDING], []
    if request.args.get("month"):
        where.append("t.month = ?"); params.append(request.args["month"])
    elif request.args.get("year"):
        where.append("substr(t.month, 1, 4) = ?"); params.append(request.args["year"])
    limit = min(int(request.args.get("limit", 20)), 200)
    params.append(limit)

    rows = db.execute(
        f"SELECT t.merchant, SUM(t.amount) AS amount, COUNT(*) AS tx_count, "
        f"MAX(t.date) AS last_seen, "
        f"COALESCE(c.name, 'Uncategorized') AS category, COALESCE(c.color, '#8b91a1') AS color "
        f"{JOIN} WHERE {' AND '.join(where)} "
        f"GROUP BY t.merchant ORDER BY amount DESC LIMIT ?", params,
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.get("/merchants/detail")
def merchant_detail():
    """Everything about one merchant: lifetime totals, per-month series, history.

    Matched on exact name — the same string the transaction list and charts show
    — so clicking a bar always lands on precisely the rows behind it.
    """
    name = request.args.get("name")
    if not name:
        return jsonify({"error": "name required"}), 400
    db = get_db()

    totals = db.execute(
        f"SELECT SUM(t.amount) AS total, COUNT(*) AS tx_count, AVG(t.amount) AS avg_amount, "
        f"MIN(t.date) AS first_seen, MAX(t.date) AS last_seen "
        f"{JOIN} WHERE {IS_SPENDING} AND t.merchant = ?", (name,),
    ).fetchone()
    if not totals["tx_count"]:
        return jsonify({"merchant": name, "tx_count": 0, "monthly": [], "transactions": []})

    monthly = [dict(r) for r in db.execute(
        f"SELECT t.month, SUM(t.amount) AS amount, COUNT(*) AS tx_count "
        f"{JOIN} WHERE {IS_SPENDING} AND t.merchant = ? "
        f"GROUP BY t.month ORDER BY t.month", (name,),
    ).fetchall()]

    transactions = [dict(r) for r in db.execute(
        "SELECT t.id, t.date, t.amount, t.direction, t.account, t.category_id, "
        "c.name AS category, c.color AS category_color "
        "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id "
        "WHERE t.merchant = ? ORDER BY t.date DESC LIMIT 100", (name,),
    ).fetchall()]

    return jsonify({
        "merchant": name,
        "total": round(totals["total"] or 0, 2),
        "tx_count": totals["tx_count"],
        "avg_amount": round(totals["avg_amount"] or 0, 2),
        "first_seen": totals["first_seen"],
        "last_seen": totals["last_seen"],
        "monthly": monthly,
        "transactions": transactions,
    })


@bp.get("/export/transactions.csv")
def export_transactions():
    """The current transaction filters, as a CSV download.

    Takes the same query parameters as `GET /api/transactions` so whatever is on
    screen is what lands in the file — no second set of filter semantics to keep
    in step with the table.
    """
    a = request.args
    where, params = [], []
    if a.get("month"):
        where.append("t.month = ?"); params.append(a["month"])
    if a.get("account"):
        where.append("t.account = ?"); params.append(a["account"])
    if a.get("direction"):
        where.append("t.direction = ?"); params.append(a["direction"])
    if a.get("uncategorized") == "1":
        where.append("t.category_id IS NULL")
    elif a.get("category_id"):
        where.append("t.category_id = ?"); params.append(a["category_id"])
    if a.get("q"):
        where.append("t.merchant LIKE ?"); params.append(f"%{a['q']}%")

    sql = ("SELECT t.date, t.merchant, t.amount, t.direction, t.account, t.bank, "
           "COALESCE(c.name, '') AS category "
           "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY t.date DESC, t.id DESC"

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "merchant", "amount", "direction", "account", "bank", "category"])
    for r in get_db().execute(sql, params):
        w.writerow([r["date"], r["merchant"], f"{r['amount']:.2f}", r["direction"],
                    r["account"], r["bank"], r["category"]])

    name = f"senya-finance-{a.get('month') or 'all'}.csv"
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
