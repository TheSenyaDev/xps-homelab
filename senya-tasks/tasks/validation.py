"""Field validation shared by task create/update/import.

One table drives create *and* update for tasks: to add a field, add the column
in a migration, then one line here. Each validator normalises the incoming
value or raises ApiError. `tags` is handled separately — it isn't a column.
"""
import re
from datetime import date

from .config import PRIORITIES, STATUSES
from .db import get_db


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def v_title(value):
    title = (value or "").strip()
    if not title:
        raise ApiError("title cannot be empty")
    return title[:500]


def v_notes(value):
    return (value or "").strip()


def v_enum(field, allowed):
    def check(value):
        value = str(value or "").strip().lower()
        if value not in allowed:
            raise ApiError(f"{field} must be one of: {', '.join(allowed)}")
        return value
    return check


def v_due_date(value):
    if value in (None, ""):
        return None
    value = str(value).strip()
    if not DATE_RE.match(value):
        raise ApiError("due_date must be YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError("due_date is not a real date")
    return value


def v_category_id(value):
    if value in (None, ""):
        return None
    try:
        cid = int(value)
    except (TypeError, ValueError):
        raise ApiError("category_id must be an integer or null")
    if get_db().execute("SELECT 1 FROM categories WHERE id = ?", (cid,)).fetchone() is None:
        raise ApiError("category not found")
    return cid


def v_int(field):
    def check(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ApiError(f"{field} must be an integer")
    return check


def v_parent_id(value):
    """The parent task, or None to promote a subtask back to top level."""
    if value in (None, "", 0):
        return None
    try:
        parent_id = int(value)
    except (TypeError, ValueError):
        raise ApiError("parent_id must be a task id")
    row = get_db().execute("SELECT id, parent_id FROM tasks WHERE id = ?",
                           (parent_id,)).fetchone()
    if row is None:
        raise ApiError("parent task does not exist")
    # One level only: a subtask cannot itself have subtasks. Deeper nesting
    # reads badly in a flat list and has no CalDAV meaning — RELATED-TO carries
    # no depth, so clients would flatten it anyway.
    if row["parent_id"] is not None:
        raise ApiError("a subtask cannot have subtasks")
    return parent_id


TASK_FIELDS = {
    "title": v_title,
    "notes": v_notes,
    "status": v_enum("status", STATUSES),
    "priority": v_enum("priority", PRIORITIES),
    "category_id": v_category_id,
    "due_date": v_due_date,
    "position": v_int("position"),
    "parent_id": v_parent_id,
}


def task_columns(data):
    """{column: value} for every recognised field present in the payload."""
    out = {}
    for field, validate in TASK_FIELDS.items():
        if field in data:
            out[field] = validate(data[field])
    # `done` is no longer a column, but it's the natural thing for a checkbox
    # (and for older clients) to send, so accept it as a shortcut for status.
    if "done" in data and "status" not in data:
        out["status"] = "done" if data["done"] else "todo"
    return out


def v_tag_name(value):
    name = re.sub(r"\s+", "-", str(value or "").strip().lower())
    if not name:
        raise ApiError("tag name cannot be empty")
    return name[:40]


def set_task_tags(db, task_id, names):
    """Replace a task's tags, creating any that don't exist yet."""
    if not isinstance(names, list):
        raise ApiError("tags must be a list of names")
    wanted = {v_tag_name(n) for n in names}
    db.execute("DELETE FROM task_tags WHERE task_id = ?", (task_id,))
    for name in sorted(wanted):
        db.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        db.execute(
            "INSERT INTO task_tags (task_id, tag_id) "
            "VALUES (?, (SELECT id FROM tags WHERE name = ?))",
            (task_id, name),
        )
