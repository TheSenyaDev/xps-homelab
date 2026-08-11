"""
Saved searches: store a query, re-run it, and report what changed.

The diff is the reason this app exists. `run` compares a fresh scrape against
every listing ever recorded for that search and classifies each item as new,
price-dropped, or unchanged — then emits events so notification channels can act
without this module knowing they exist.
"""

from __future__ import annotations

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from .. import events, sites
from ..db import get_db

bp = Blueprint("searches", __name__)


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def fail(msg, code=400):
    return jsonify({"error": msg}), code


def _opts_for(row):
    """SearchOptions from a stored row."""
    return sites.SearchOptions.from_dict({
        "query": row["query"], "sort": row["sort"], "condition": row["condition"],
        "category": row["category"], "min_price": row["min_price"],
        "max_price": row["max_price"],
    })


@bp.get("/searches")
def list_searches():
    rows = get_db().execute("""
        SELECT s.*,
               (SELECT COUNT(*) FROM listings l
                 WHERE l.search_id = s.id AND l.gone = 0) AS live_count
          FROM searches s ORDER BY s.created_at DESC
    """).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/searches")
def create_search():
    body = request.get_json(silent=True) or {}
    opts = sites.SearchOptions.from_dict(body)
    if not opts.query:
        return fail("A saved search needs a query.")
    site = body.get("site") or "ebay-ca"
    try:
        sites.get(site)
    except sites.ScrapeError as e:
        return fail(str(e))
    db = get_db()
    cur = db.execute(
        """INSERT INTO searches
               (name, site, query, sort, condition, category, min_price, max_price, notify)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        ((body.get("name") or opts.query).strip(), site, opts.query, opts.sort,
         opts.condition, opts.category, opts.min_price, opts.max_price,
         0 if body.get("notify") is False else 1))
    db.commit()
    row = db.execute("SELECT * FROM searches WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@bp.delete("/searches/<int:sid>")
def delete_search(sid):
    db = get_db()
    db.execute("DELETE FROM searches WHERE id=?", (sid,))
    db.commit()
    return "", 204


@bp.post("/searches/<int:sid>/run")
def run_search(sid):
    db = get_db()
    row = db.execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    if not row:
        return fail("No such saved search.", 404)
    try:
        items = sites.get(row["site"]).search(_opts_for(row))
    except sites.UnknownSite as e:
        return fail(str(e))
    except sites.ScrapeError as e:
        # A blocked or restructured site is an upstream problem, not a bug here:
        # 502 says so, and the message tells the user what to do about it.
        return fail(str(e), 502)

    stamp = now()
    seen, new_items, drops = set(), [], []

    for it in items:
        seen.add(it.uid)
        prev = db.execute("SELECT * FROM listings WHERE search_id=? AND uid=?",
                          (sid, it.uid)).fetchone()
        if prev is None:
            db.execute("""INSERT INTO listings
                (search_id, uid, title, url, price, first_price, currency, price_text,
                 condition, shipping, seller, image, first_seen, last_seen, gone)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)""",
                (sid, it.uid, it.title, it.url, it.price, it.price, it.currency,
                 it.price_text, it.condition, it.shipping, it.seller, it.image,
                 stamp, stamp))
            new_items.append(it.as_dict())
        else:
            # Compared against the last recorded price, so a slow slide over
            # several runs is reported each time it actually moves.
            if (prev["price"] is not None and it.price is not None
                    and it.price < prev["price"]):
                d = it.as_dict()
                d["was"] = prev["price"]
                drops.append(d)
            db.execute("""UPDATE listings SET title=?, url=?, price=?, price_text=?,
                          condition=?, shipping=?, seller=?, image=?, last_seen=?, gone=0
                          WHERE id=?""",
                       (it.title, it.url, it.price, it.price_text, it.condition,
                        it.shipping, it.seller, it.image, stamp, prev["id"]))

    # Anything missing from this run has left the results: flagged, not deleted,
    # so it stops showing as live without being announced as new if it returns.
    for r in db.execute("SELECT id, uid FROM listings WHERE search_id=? AND gone=0",
                        (sid,)).fetchall():
        if r["uid"] not in seen:
            db.execute("UPDATE listings SET gone=1 WHERE id=?", (r["id"],))

    db.execute("UPDATE searches SET last_run_at=? WHERE id=?", (stamp, sid))
    db.commit()

    # Fire and forget: handlers cannot fail this request (see scraper/events.py).
    if row["notify"]:
        search = dict(row)
        if new_items:
            events.emit("listings.new", {"search": search, "listings": new_items})
        if drops:
            events.emit("listings.price_drop", {"search": search, "listings": drops})

    return jsonify({
        "ran_at": stamp,
        "total": len(items),
        "new": new_items,
        "price_drops": drops,
        "results": [i.as_dict() for i in items],
    })


@bp.get("/searches/<int:sid>/results")
def search_results(sid):
    """Everything stored for a saved search, newest first. `include_gone=1` also
    returns listings that have left the results."""
    sql = "SELECT * FROM listings WHERE search_id=?"
    if request.args.get("include_gone") != "1":
        sql += " AND gone=0"
    sql += " ORDER BY first_seen DESC, id DESC"
    return jsonify([dict(r) for r in get_db().execute(sql, (sid,)).fetchall()])
