from flask import Blueprint, jsonify, request

from ..config import PRIORITIES, STATUSES
from ..db import get_db
from ..markdown_export import sync
from ..serialize import read_task, tags_by_task, task_json
from ..validation import (ApiError, set_task_tags, task_columns, v_due_date, v_enum,
                          v_int, v_tag_name)

bp = Blueprint("tasks", __name__, url_prefix="/api")


def task_filters(args):
    """Turn query-string filters into a (WHERE fragment, params) pair.

    Shared by GET /api/tasks and the markdown export so both understand exactly
    the same filters — export what you're looking at, without a second dialect.
    """
    where, params = [], []

    if "status" in args:
        where.append("status = ?")
        params.append(v_enum("status", STATUSES)(args["status"]))
    if "priority" in args:
        where.append("priority = ?")
        params.append(v_enum("priority", PRIORITIES)(args["priority"]))
    if "category_id" in args:
        where.append("category_id IS ?")
        # A bad filter is the caller's mistake, so say so — letting int() raise
        # here surfaced as a 500 with no indication of which parameter was wrong.
        params.append(None if args["category_id"] in ("", "none")
                      else v_int("category_id")(args["category_id"]))
    if "due_before" in args:
        where.append("(due_date IS NOT NULL AND due_date <= ?)")
        params.append(v_due_date(args["due_before"]))
    if args.get("q"):
        where.append("(title LIKE ? OR notes LIKE ?)")
        params += [f"%{args['q']}%"] * 2
    if args.get("tag"):
        where.append(
            "id IN (SELECT tt.task_id FROM task_tags tt JOIN tags g ON g.id = tt.tag_id "
            "WHERE g.name = ?)")
        params.append(v_tag_name(args["tag"]))
    if "ids" in args:
        # Lets the client export exactly what's on screen — its search box and
        # tag chips filter client-side, so no server-side filter can reproduce
        # that view. An empty list means "nothing", not "everything".
        ids = [v_int("ids")(x) for x in args["ids"].split(",") if x.strip()]
        where.append(f"id IN ({', '.join('?' * len(ids))})" if ids else "0")
        params += ids

    return (" WHERE " + " AND ".join(where)) if where else "", params


def filtered_tasks(db, args):
    where, params = task_filters(args)
    return db.execute(
        f"SELECT * FROM tasks{where} ORDER BY status = 'done', position, id", params
    ).fetchall()


@bp.get("/tasks")
def list_tasks():
    """Optional filters: ?status= ?priority= ?category_id= ?tag= ?q= ?due_before="""
    db = get_db()
    rows = filtered_tasks(db, request.args)
    tags = tags_by_task(db, {r["id"] for r in rows})
    return jsonify([task_json(r, tags.get(r["id"], [])) for r in rows])


@bp.post("/tasks")
def create_task():
    data = request.get_json(force=True, silent=True) or {}
    if "title" not in data:
        raise ApiError("title is required")
    cols = task_columns(data)
    db = get_db()
    cols.setdefault(
        "position",
        db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM tasks").fetchone()[0],
    )
    cur = db.execute(
        f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
        list(cols.values()),
    )
    if "tags" in data:
        set_task_tags(db, cur.lastrowid, data["tags"])
    db.commit()
    sync()
    return jsonify(read_task(db, cur.lastrowid)), 201


def guard_parenting(db, task_id, cols):
    """Reject re-parenting that would create a cycle or a third level."""
    if "parent_id" not in cols:
        return
    parent_id = cols["parent_id"]
    if parent_id == task_id:
        raise ApiError("a task cannot be its own parent")
    if parent_id is not None:
        kids = db.execute("SELECT COUNT(*) FROM tasks WHERE parent_id = ?",
                          (task_id,)).fetchone()[0]
        if kids:
            raise ApiError("this task has subtasks, so it cannot become one")


@bp.patch("/tasks/<int:task_id>")
def update_task(task_id):
    data = request.get_json(force=True, silent=True) or {}
    cols = task_columns(data)
    if not cols and "tags" not in data:
        raise ApiError("nothing to update")
    db = get_db()
    guard_parenting(db, task_id, cols)
    if db.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone() is None:
        raise ApiError("not found", 404)
    if cols:
        db.execute(
            f"UPDATE tasks SET {', '.join(f'{c} = ?' for c in cols)} WHERE id = ?",
            [*cols.values(), task_id],
        )
    if "tags" in data:
        set_task_tags(db, task_id, data["tags"])
    db.commit()
    sync()
    return jsonify(read_task(db, task_id))


@bp.post("/tasks/reorder")
def reorder_tasks():
    """Body: {"ids": [3, 1, 2]} — writes `position` in the order given."""
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list):
        raise ApiError("ids must be a list of task ids")
    db = get_db()
    for pos, tid in enumerate(ids, start=1):
        db.execute("UPDATE tasks SET position = ? WHERE id = ?",
                   (pos, v_int("ids")(tid)))
    db.commit()
    sync()
    return "", 204


@bp.delete("/tasks/<int:task_id>")
def delete_task(task_id):
    db = get_db()
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    sync()
    return "", 204
