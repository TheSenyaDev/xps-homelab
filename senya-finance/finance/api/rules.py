import re

from flask import Blueprint, jsonify, request

from ..categorize import categorize, income_category_id, load_rules, match_category
from ..db import get_db

bp = Blueprint("rules", __name__, url_prefix="/api")


@bp.get("/rules")
def list_rules():
    rows = get_db().execute(
        "SELECT r.*, c.name AS category, c.color AS category_color "
        "FROM rules r JOIN categories c ON c.id = r.category_id "
        "ORDER BY r.priority, r.id"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/rules")
def create_rule():
    data = request.get_json(force=True) or {}
    pattern = (data.get("pattern") or "").strip()
    category_id = data.get("category_id")
    if not pattern or not category_id:
        return jsonify({"error": "pattern and category_id are required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO rules (pattern, is_regex, category_id, priority) VALUES (?, ?, ?, ?)",
        (pattern, 1 if data.get("is_regex") else 0, category_id, int(data.get("priority", 100))),
    )
    db.commit()
    return jsonify(dict(db.execute("SELECT * FROM rules WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@bp.delete("/rules/<int:rid>")
def delete_rule(rid):
    db = get_db()
    db.execute("DELETE FROM rules WHERE id = ?", (rid,))
    db.commit()
    return "", 204


@bp.post("/rules/apply")
def apply_rules():
    """Re-run categorization over transactions.

    Default scope is `uncategorized` — the safe one, which can only ever fill in
    a blank. `scope=all` also re-runs over rows that already have a category,
    which will overwrite categories you set by hand; the UI asks first.
    """
    scope = (request.args.get("scope") or (request.get_json(silent=True) or {}).get("scope")
             or "uncategorized")
    db = get_db()
    rules = load_rules(db)
    income_id = income_category_id(db)

    sql = "SELECT id, merchant, direction, category_id FROM transactions"
    if scope != "all":
        sql += " WHERE category_id IS NULL"
    rows = db.execute(sql).fetchall()

    filled = changed = 0
    for r in rows:
        cid = categorize(rules, r["merchant"], r["direction"], income_id)
        if cid is None or cid == r["category_id"]:
            continue
        db.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (cid, r["id"]))
        if r["category_id"] is None:
            filled += 1
        else:
            changed += 1
    db.commit()
    # `categorized` keeps its original meaning (rows that went from blank to set)
    # so existing callers and the toast text stay correct.
    return jsonify({"categorized": filled, "recategorized": changed, "scope": scope})


@bp.post("/rules/preview")
def preview_rule():
    """What *would* a pattern match? Lets you see before you save.

    Reports the whole matching set and how much of it is already categorized,
    so a pattern that would quietly re-label existing work is visible up front.
    """
    data = request.get_json(force=True) or {}
    pattern = (data.get("pattern") or "").strip()
    if not pattern:
        return jsonify({"error": "pattern is required"}), 400

    if data.get("is_regex"):
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            return jsonify({"error": f"invalid regex: {exc}"}), 400
        matches = lambda m: rx.search(m) is not None          # noqa: E731
    else:
        needle = pattern.upper()
        matches = lambda m: needle in m.upper()               # noqa: E731

    rows = get_db().execute(
        "SELECT t.id, t.date, t.merchant, t.amount, t.direction, t.category_id, c.name AS category "
        "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id "
        "ORDER BY t.date DESC"
    ).fetchall()
    hits = [dict(r) for r in rows if matches(r["merchant"])]

    return jsonify({
        "count": len(hits),
        "uncategorized": sum(1 for h in hits if h["category_id"] is None),
        "already_categorized": sum(1 for h in hits if h["category_id"] is not None),
        "total_amount": round(sum(h["amount"] for h in hits), 2),
        "sample": hits[:12],
    })


@bp.get("/rules/suggestions")
def rule_suggestions():
    """Uncategorized merchants worth writing a rule for, biggest money first.

    Repeated merchants are the ones a rule pays off on, so anything seen once is
    left out — label those individually instead.
    """
    db = get_db()
    rules = load_rules(db)
    rows = db.execute(
        "SELECT merchant, COUNT(*) AS tx_count, ROUND(SUM(amount), 2) AS amount, "
        "MAX(date) AS last_seen "
        "FROM transactions WHERE category_id IS NULL AND direction = 'out' "
        "GROUP BY merchant HAVING tx_count > 1 ORDER BY amount DESC LIMIT 25"
    ).fetchall()
    # A merchant an existing rule already claims isn't a suggestion — it just
    # hasn't had "apply" run over it yet.
    out = [dict(r) for r in rows if match_category(rules, r["merchant"]) is None]
    return jsonify(out)
