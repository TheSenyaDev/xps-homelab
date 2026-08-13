"""Everything a client needs to build its pickers without hardcoding them."""
from flask import Blueprint, jsonify

from ..config import MARKDOWN_PATH, PRIORITIES, STATUSES
from ..db import get_db

bp = Blueprint("meta", __name__, url_prefix="/api")


@bp.get("/meta")
def meta():
    db = get_db()
    counts = dict(db.execute(
        "SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall())
    return jsonify({
        "schema_version": db.execute("PRAGMA user_version").fetchone()[0],
        "statuses": list(STATUSES),
        "priorities": list(PRIORITIES),
        "counts": {s: counts.get(s, 0) for s in STATUSES},
        "markdown_path": MARKDOWN_PATH,
    })
