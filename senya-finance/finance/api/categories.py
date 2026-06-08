from flask import Blueprint, jsonify, request

from ..db import get_db

bp = Blueprint("categories", __name__, url_prefix="/api")

KINDS = ("expense", "income", "transfer")


@bp.get("/categories")
def list_categories():
    rows = get_db().execute(
        "SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS tx_count "
        "FROM categories c ORDER BY c.kind, c.name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/categories")
def create_category():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    kind = data.get("kind") if data.get("kind") in KINDS else "expense"
    color = (data.get("color") or "#6366f1").strip()
    db = get_db()
    if db.execute("SELECT 1 FROM categories WHERE name = ?", (name,)).fetchone():
        return jsonify({"error": "category already exists"}), 409
    cur = db.execute("INSERT INTO categories (name, color, kind) VALUES (?, ?, ?)", (name, color, kind))
    db.commit()
    return jsonify(dict(db.execute("SELECT * FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@bp.patch("/categories/<int:cid>")
def update_category(cid):
    data = request.get_json(force=True) or {}
    fields, values = [], []
    if "name" in data and data["name"].strip():
        fields.append("name = ?"); values.append(data["name"].strip())
    if "color" in data:
        fields.append("color = ?"); values.append(data["color"])
    if data.get("kind") in KINDS:
        fields.append("kind = ?"); values.append(data["kind"])
    if not fields:
        return jsonify({"error": "nothing to update"}), 400
    values.append(cid)
    db = get_db()
    db.execute(f"UPDATE categories SET {', '.join(fields)} WHERE id = ?", values)
    db.commit()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (cid,)).fetchone()
    return (jsonify(dict(row)), 200) if row else (jsonify({"error": "not found"}), 404)


@bp.delete("/categories/<int:cid>")
def delete_category(cid):
    db = get_db()
    db.execute("DELETE FROM categories WHERE id = ?", (cid,))  # tx.category_id -> NULL via FK
    db.commit()
    return "", 204
