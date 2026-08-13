from flask import Blueprint, jsonify, request

from ..config import STATUSES
from ..db import get_db
from ..markdown_export import sync
from ..markdown_import import lookup_category_path, parse_markdown, resolve_category_path
from ..validation import ApiError, set_task_tags, task_columns, v_due_date, v_enum

bp = Blueprint("imports", __name__, url_prefix="/api/import")


@bp.post("/preview")
def import_preview():
    """Parse pasted markdown and hand back proposed tasks. Writes nothing."""
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("markdown")
    if not isinstance(text, str) or not text.strip():
        raise ApiError("markdown is required")

    items = parse_markdown(text, default_status=v_enum("status", STATUSES)(
        data.get("default_status") or "todo"))

    db = get_db()
    existing = {r["title"].strip().lower() for r in db.execute("SELECT title FROM tasks")}
    known_paths = {}
    for row in db.execute("SELECT id, name, parent_id FROM categories"):
        known_paths[(row["parent_id"], row["name"].lower())] = row["id"]

    seen = set()
    for item in items:
        key = item["title"].strip().lower()
        if key and key in existing:
            item["warnings"].append("a task with this title already exists")
            item["duplicate"] = True
        if key and key in seen:
            item["warnings"].append("duplicated within this paste")
            item["duplicate"] = True
        seen.add(key)

        # Tell the reviewer which categories the import would have to create.
        parent, new_path = None, []
        for name in item["category_path"]:
            found = known_paths.get((parent, name.lower()))
            if found is None:
                new_path.append(name)
                parent = None
                break
            parent = found
        item["new_categories"] = new_path

    return jsonify({
        "items": items,
        "counts": {
            "parsed": len(items),
            "selected": sum(1 for i in items if i["include"]),
            "warnings": sum(1 for i in items if i["warnings"]),
        },
    })


@bp.post("/commit")
def import_commit():
    """Insert the reviewed tasks. All or nothing — a bad row aborts the batch.

    Items come from the client *after* editing, so every field goes back through
    the same TASK_FIELDS validators used by POST /api/tasks; the import path has
    no privileged shortcut into the database.
    """
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items")
    if not isinstance(items, list):
        raise ApiError("items must be a list")
    items = [i for i in items if i.get("include", True)]
    if not items:
        raise ApiError("nothing selected to import")
    make_categories = bool(data.get("create_categories", True))

    db = get_db()
    created_categories = []
    created_ids = []
    try:
        db.execute("BEGIN")
        pos = db.execute("SELECT COALESCE(MAX(position), 0) FROM tasks").fetchone()[0]
        for n, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                raise ApiError(f"item {n} is not an object")
            cols = task_columns(item)
            if not cols.get("title"):
                raise ApiError(f"item {n}: title is required")

            if "category_id" not in item and item.get("category_path"):
                path = item["category_path"]
                if not isinstance(path, list):
                    raise ApiError(f"item {n}: category_path must be a list")
                cols["category_id"] = (
                    resolve_category_path(db, path, created_categories)
                    if make_categories
                    else lookup_category_path(db, path)
                )

            pos += 1
            cols["position"] = pos
            cur = db.execute(
                f"INSERT INTO tasks ({', '.join(cols)}) "
                f"VALUES ({', '.join('?' * len(cols))})",
                list(cols.values()),
            )
            if item.get("tags"):
                set_task_tags(db, cur.lastrowid, item["tags"])
            # Keep the ✅ date from the file. The completed_at trigger stamps
            # "now" on insert, which would silently rewrite history on import.
            if item.get("completed_at") and cols.get("status") == "done":
                db.execute(
                    "UPDATE tasks SET completed_at = ? WHERE id = ?",
                    (v_due_date(item["completed_at"]), cur.lastrowid),
                )
            created_ids.append(cur.lastrowid)
        db.commit()
    except Exception:
        db.rollback()
        raise

    sync()
    return jsonify({
        "created": len(created_ids),
        "categories_created": created_categories,
        "ids": created_ids,
    }), 201
