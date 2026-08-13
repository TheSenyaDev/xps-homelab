from flask import Blueprint, jsonify, request

from ..db import get_db
from ..markdown_export import sync
from ..validation import ApiError, v_int

bp = Blueprint("categories", __name__, url_prefix="/api")


@bp.get("/categories")
def list_categories():
    rows = get_db().execute(
        "SELECT * FROM categories ORDER BY position, name").fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/categories")
def create_category():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        raise ApiError("name is required")
    color = (data.get("color") or "#6366f1").strip()
    parent_id = data.get("parent_id")
    db = get_db()

    if parent_id is not None:
        if db.execute("SELECT 1 FROM categories WHERE id = ?", (parent_id,)).fetchone() is None:
            raise ApiError("parent category not found")

    # explicit dup check (UNIQUE treats NULL parents as distinct, so guard here)
    if parent_id is None:
        dup = db.execute(
            "SELECT 1 FROM categories WHERE name = ? AND parent_id IS NULL", (name,)
        ).fetchone()
    else:
        dup = db.execute(
            "SELECT 1 FROM categories WHERE name = ? AND parent_id = ?", (name, parent_id)
        ).fetchone()
    if dup:
        raise ApiError("category already exists here", 409)

    nxt = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories").fetchone()[0]
    cur = db.execute(
        "INSERT INTO categories (name, color, parent_id, position) VALUES (?, ?, ?, ?)",
        (name, color, parent_id, nxt),
    )
    db.commit()
    sync()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


def would_cycle(db, cat_id, parent_id):
    """True if making `parent_id` the parent of `cat_id` closes a loop.

    Dragging makes this trivially reachable — dropping a parent onto its own
    child is a natural mistake — and the result is a subtree that vanishes from
    the sidebar (the tree walk starts at parent_id IS NULL and never reaches it)
    while its rows still exist. Cheaper to refuse than to explain.
    """
    seen = set()
    while parent_id is not None and parent_id not in seen:
        if parent_id == cat_id:
            return True
        seen.add(parent_id)
        row = db.execute("SELECT parent_id FROM categories WHERE id = ?",
                         (parent_id,)).fetchone()
        if row is None:
            return False
        parent_id = row["parent_id"]
    return False


@bp.patch("/categories/<int:cat_id>")
def update_category(cat_id):
    data = request.get_json(force=True, silent=True) or {}
    fields, values = [], []
    for key in ("name", "color"):
        if key in data:
            val = (data[key] or "").strip()
            if not val:
                raise ApiError(f"{key} cannot be empty")
            fields.append(f"{key} = ?")
            values.append(val)
    if "position" in data:
        fields.append("position = ?")
        values.append(v_int("position")(data["position"]))
    if "parent_id" in data:
        parent_id = data["parent_id"]
        if parent_id not in (None, ""):
            parent_id = int(parent_id)
            if parent_id == cat_id:
                raise ApiError("a category cannot be its own parent")
            if would_cycle(get_db(), cat_id, parent_id):
                raise ApiError("that would nest a category inside its own subtree")
        else:
            parent_id = None
        fields.append("parent_id = ?")
        values.append(parent_id)
    if not fields:
        raise ApiError("nothing to update")
    db = get_db()
    if db.execute("SELECT 1 FROM categories WHERE id = ?", (cat_id,)).fetchone() is None:
        raise ApiError("not found", 404)
    values.append(cat_id)
    db.execute(f"UPDATE categories SET {', '.join(fields)} WHERE id = ?", values)
    db.commit()
    sync()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
    return jsonify(dict(row))


@bp.post("/categories/reorder")
def reorder_categories():
    """Body: {"items": [{"id": 5, "parent_id": 4, "position": 1}, ...]}

    One call for the whole affected slice rather than a PATCH per row: a drag
    moves one category but renumbers its siblings, and applying that as
    separate requests would leave the tree briefly inconsistent — and wholly
    inconsistent if one of them failed.
    """
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items")
    if not isinstance(items, list) or not items:
        raise ApiError("items must be a non-empty list")

    db = get_db()
    known = {r["id"] for r in db.execute("SELECT id FROM categories").fetchall()}
    parsed = []
    for it in items:
        try:
            cid = int(it["id"])
            pos = int(it["position"])
        except (KeyError, TypeError, ValueError):
            raise ApiError("each item needs an id and a position")
        if cid not in known:
            raise ApiError(f"no category {cid}")
        parent = it.get("parent_id")
        parent = None if parent in (None, "", 0) else int(parent)
        if parent is not None and parent not in known:
            raise ApiError(f"no category {parent}")
        if parent == cid:
            raise ApiError("a category cannot be its own parent")
        parsed.append((cid, parent, pos))

    # Validated as a set, before writing anything: checking each row as it is
    # written could accept the first half of a move and reject the second.
    for cid, parent, _ in parsed:
        if parent is not None and would_cycle(db, cid, parent):
            raise ApiError("that would nest a category inside its own subtree")

    for cid, parent, pos in parsed:
        db.execute("UPDATE categories SET parent_id = ?, position = ? WHERE id = ?",
                   (parent, pos, cid))
    db.commit()
    sync()
    return jsonify([dict(r) for r in db.execute(
        "SELECT * FROM categories ORDER BY position, name").fetchall()])


@bp.delete("/categories/<int:cat_id>")
def delete_category(cat_id):
    db = get_db()
    db.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
    db.commit()
    sync()
    return "", 204
