"""Recurring charges / subscriptions."""
from flask import Blueprint, jsonify, request

from ..db import get_db
from ..recurring import as_of_date, detect, summarize

bp = Blueprint("recurring", __name__, url_prefix="/api")


@bp.get("/recurring")
def list_recurring():
    """Detected recurring charges, plus what they cost per month and per year.

    `?years=` bounds how far back to look (default 3): detection needs history,
    but a subscription cancelled in 2019 isn't worth reporting on.
    """
    years = min(max(int(request.args.get("years", 3)), 1), 20)
    rows = get_db().execute(
        "SELECT t.date, t.merchant, t.amount, t.direction, t.account, "
        "t.category_id, c.name AS category, c.color AS category_color "
        "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id "
        "WHERE t.date >= date('now', ?) ORDER BY t.date",
        (f"-{years} years",),
    ).fetchall()

    txs = [dict(r) for r in rows]
    as_of = as_of_date(txs)
    series = detect(txs)
    if request.args.get("active") == "1":
        series = [s for s in series if s["active"]]
    # The client shows this: "active" is relative to the last imported statement,
    # not to today, and saying so avoids a confusing read after a stale import.
    return jsonify({"as_of": as_of.isoformat(), "summary": summarize(series), "series": series})
