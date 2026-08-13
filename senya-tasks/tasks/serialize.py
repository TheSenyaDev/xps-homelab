"""Turning DB rows into the JSON shape the API returns."""
from collections import defaultdict


def tags_by_task(db, task_ids=None):
    rows = db.execute(
        "SELECT tt.task_id, t.name, t.color FROM task_tags tt "
        "JOIN tags t ON t.id = tt.tag_id ORDER BY t.name"
    ).fetchall()
    out = defaultdict(list)
    for r in rows:
        if task_ids is None or r["task_id"] in task_ids:
            out[r["task_id"]].append({"name": r["name"], "color": r["color"]})
    return out


def task_json(row, tags):
    t = dict(row)
    t["done"] = t["status"] == "done"  # convenience mirror of status
    t["tags"] = tags
    return t


def read_task(db, task_id):
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return task_json(row, tags_by_task(db, {task_id}).get(task_id, []))
