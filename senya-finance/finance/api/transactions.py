from flask import Blueprint, jsonify, request

from ..db import get_db

bp = Blueprint("transactions", __name__, url_prefix="/api")

_SELECT = (
    "SELECT t.*, c.name AS category, c.color AS category_color, c.kind AS category_kind "
    "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id"
)


@bp.get("/transactions")
def list_transactions():
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

    sql = _SELECT + (" WHERE " + " AND ".join(where) if where else "")
    sql += " ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?"
    limit = min(int(a.get("limit", 200)), 2000)
    params += [limit, int(a.get("offset", 0))]
    rows = get_db().execute(sql, params).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.patch("/transactions/<int:tid>")
def update_transaction(tid):
    data = request.get_json(force=True) or {}
    if "category_id" not in data:
        return jsonify({"error": "category_id required"}), 400
    db = get_db()
    db.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (data["category_id"], tid))
    db.commit()
    row = db.execute(_SELECT + " WHERE t.id = ?", (tid,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(dict(row))


@bp.get("/accounts")
def list_accounts():
    rows = get_db().execute("SELECT DISTINCT account FROM transactions ORDER BY account").fetchall()
    return jsonify([r["account"] for r in rows])
