from datetime import date

from flask import Blueprint, current_app, request

from ..db import get_db
from ..markdown_export import build_markdown
from .tasks import filtered_tasks

bp = Blueprint("export", __name__, url_prefix="/api")


@bp.get("/export")
def export_markdown():
    """The same markdown that lands in Tasks.md, on demand and filterable.

    Accepts every GET /api/tasks filter, so "export what I'm looking at" is one
    request. `?download=1` makes the browser save it instead of showing it.
    """
    db = get_db()
    args = request.args
    filters = {k: v for k, v in args.items() if k != "download"}
    include = None if not filters else {r["id"] for r in filtered_tasks(db, args)}
    text = build_markdown(db, include_ids=include)

    resp = current_app.response_class(text, mimetype="text/markdown")  # Flask adds the charset
    if args.get("download"):
        name = f"senya-tasks-{date.today().isoformat()}.md"
        resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return resp
