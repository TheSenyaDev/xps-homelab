from flask import Blueprint, jsonify, request

from ..db import get_db
from ..markdown_export import sync
from ..validation import ApiError, v_tag_name

bp = Blueprint("tags", __name__, url_prefix="/api")


@bp.get("/tags")
def list_tags():
    rows = get_db().execute(
        "SELECT t.*, COUNT(tt.task_id) AS task_count FROM tags t "
        "LEFT JOIN task_tags tt ON tt.tag_id = t.id GROUP BY t.id ORDER BY t.name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.patch("/tags/<int:tag_id>")
def update_tag(tag_id):
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    if db.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
        raise ApiError("not found", 404)
    if "color" in data:
        db.execute("UPDATE tags SET color = ? WHERE id = ?",
                   ((data["color"] or "").strip(), tag_id))
    if "name" in data:
        db.execute("UPDATE tags SET name = ? WHERE id = ?",
                   (v_tag_name(data["name"]), tag_id))
    db.commit()
    sync()
    row = db.execute("SELECT * FROM tags WHERE id = ?", (tag_id,)).fetchone()
    return jsonify(dict(row))


@bp.delete("/tags/<int:tag_id>")
def delete_tag(tag_id):
    db = get_db()
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    db.commit()
    sync()
    return "", 204
