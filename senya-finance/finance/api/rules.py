from flask import Blueprint, jsonify, request

from ..categorize import categorize, income_category_id, load_rules
from ..db import get_db

bp = Blueprint("rules", __name__, url_prefix="/api")


@bp.get("/rules")
def list_rules():
    rows = get_db().execute(
        "SELECT r.*, c.name AS category, c.color AS category_color "
        "FROM rules r JOIN categories c ON c.id = r.category_id "
        "ORDER BY r.priority, r.id"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/rules")
def create_rule():
    data = request.get_json(force=True) or {}
    pattern = (data.get("pattern") or "").strip()
    category_id = data.get("category_id")
    if not pattern or not category_id:
        return jsonify({"error": "pattern and category_id are required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO rules (pattern, is_regex, category_id, priority) VALUES (?, ?, ?, ?)",
        (pattern, 1 if data.get("is_regex") else 0, category_id, int(data.get("priority", 100))),
    )
    db.commit()
    return jsonify(dict(db.execute("SELECT * FROM rules WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@bp.delete("/rules/<int:rid>")
def delete_rule(rid):
    db = get_db()
    db.execute("DELETE FROM rules WHERE id = ?", (rid,))
    db.commit()
    return "", 204


@bp.post("/rules/apply")
def apply_rules():
    """Re-run categorization over all currently-uncategorized transactions.
    Useful after adding rules. Won't override already-categorized rows."""
    db = get_db()
    rules = load_rules(db)
    income_id = income_category_id(db)
    rows = db.execute("SELECT id, merchant, direction FROM transactions WHERE category_id IS NULL").fetchall()
    n = 0
    for r in rows:
        cid = categorize(rules, r["merchant"], r["direction"], income_id)
        if cid is not None:
            db.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (cid, r["id"]))
            n += 1
    db.commit()
    return jsonify({"categorized": n})
