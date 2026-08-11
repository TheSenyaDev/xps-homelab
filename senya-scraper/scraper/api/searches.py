"""
Saved searches: store a query, re-run it, and report what changed.

The diff is the reason this app exists. `run` compares a fresh scrape against
every listing ever recorded for that search and classifies each item as new,
price-dropped, or unchanged — then emits events so notification channels can act
without this module knowing they exist.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from .. import aggregate, events, sites
from ..db import get_db

bp = Blueprint("searches", __name__)


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def fail(msg, code=400):
    return jsonify({"error": msg}), code


def _params_map(row):
    """The stored per-site params, as {site: {option: value}}."""
    try:
        data = json.loads(row["params"] or "{}")
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError, IndexError, KeyError):
        return {}


def _blocked(row):
    """The search's seller blocklist, lowercased for matching."""
    try:
        raw = json.loads(row["blocked_sellers"] or "[]")
    except (ValueError, TypeError, IndexError, KeyError):
        return set()
    if not isinstance(raw, list):
        return set()
    return {str(s).strip().lower() for s in raw if str(s).strip()}


def parse_blocklist(value):
    """Accept a JSON array or a free-typed string (commas/newlines), since the
    dialog is a textarea and pasting a list should just work."""
    if value is None:
        return None
    if isinstance(value, str):
        parts = value.replace(",", "\n").split("\n")
    elif isinstance(value, (list, tuple)):
        parts = [str(v) for v in value]
    else:
        return []
    seen, out = set(), []
    for p in parts:
        name = p.strip().lstrip("@")
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out


def apply_blocklist(items, blocked):
    """Drop listings from blocked sellers.

    Filtered here rather than by asking the site to exclude them: not every
    marketplace supports it, and doing it locally means one behaviour for all of
    them. Returns (kept, dropped_count) so the UI can say what it hid instead of
    the results silently coming up short.
    """
    if not blocked:
        return items, 0
    kept = [i for i in items if (i.seller_name or "").lower() not in blocked]
    return kept, len(items) - len(kept)


def _sites_for(row):
    """Which marketplaces this saved search covers.

    Falls back to the legacy single `site` column when `sites` is empty, so rows
    created before multi-site existed keep working untouched.
    """
    try:
        listed = json.loads(row["sites"] or "[]")
    except (ValueError, TypeError, IndexError, KeyError):
        listed = []
    if not isinstance(listed, list) or not listed:
        listed = [row["site"]]
    try:
        return aggregate.resolve(listed)
    except sites.UnknownSite:
        # A site was removed from the install since this was saved. Keep the
        # ones that still exist rather than making the whole search unrunnable.
        return [k for k in listed if k in sites.keys()] or [sites.keys()[0]]


def _opts_for(row):
    """SearchOptions from a stored row. Per-site params are applied by
    aggregate.search_many, which hands each adapter only its own."""
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


def _fields_from(body, defaults=None):
    """Validate a create/update payload into the columns of `searches`.

    Returns (fields, error). On update, `defaults` is the existing row, so a
    partial payload only changes what it actually mentions — otherwise editing
    just the price would blank the query.
    """
    d = dict(defaults) if defaults else {}
    merged = {
        "query": body.get("query", d.get("query", "")),
        "sort": body.get("sort", d.get("sort", "best")),
        "condition": body.get("condition", d.get("condition", "any")),
        "category": body.get("category", d.get("category", "")),
        "min_price": body.get("min_price", d.get("min_price")),
        "max_price": body.get("max_price", d.get("max_price")),
    }
    opts = sites.SearchOptions.from_dict(merged)
    if not opts.query:
        return None, "A saved search needs something to search for."

    # A search can cover several marketplaces. `site` is kept as the first of
    # them so the older column stays meaningful for anything still reading it.
    requested = body.get("sites")
    if requested is None:
        requested = body.get("site") or json.loads(d.get("sites") or "[]") or d.get("site") or "ebay-ca"
    try:
        keys = aggregate.resolve(requested)
    except sites.ScrapeError as e:
        return None, str(e)
    if not keys:
        return None, "Pick at least one site to search."
    site = keys[0]

    if (opts.min_price is not None and opts.max_price is not None
            and opts.min_price > opts.max_price):
        # Cheap to catch here; the site would just return nothing and look broken.
        return None, "Minimum price is above the maximum."

    # Site-specific filters, merged into whatever the profile already held for
    # other sites so editing an eBay profile never discards a Kijiji one.
    stored = {}
    if defaults:
        try:
            stored = json.loads(d.get("params") or "{}")
        except (ValueError, TypeError):
            stored = {}
        if not isinstance(stored, dict):
            stored = {}
    if "params" in body:
        # Either {site: {...}} for a multi-site search, or bare options for a
        # single one. Each site validates its own, so unknown keys are dropped
        # rather than stored and later smuggled into a URL.
        incoming = body.get("params") or {}
        if incoming and all(k in keys for k in incoming):
            for key, values in incoming.items():
                stored[key] = sites.get(key).clean_params(values or {})
        elif len(keys) == 1:
            stored[site] = sites.get(site).clean_params(incoming)

    blocked = parse_blocklist(body.get("blocked_sellers"))
    if blocked is None:                       # not mentioned → leave as-is
        blocked_json = d.get("blocked_sellers") or "[]"
    else:
        blocked_json = json.dumps(blocked)

    notify = body.get("notify", d.get("notify", 1))
    return {
        "blocked_sellers": blocked_json,
        "name": (body.get("name") or d.get("name") or opts.query).strip(),
        "site": site,
        "query": opts.query,
        "sort": opts.sort,
        "condition": opts.condition,
        "category": opts.category,
        "min_price": opts.min_price,
        "max_price": opts.max_price,
        "notify": 0 if notify in (False, 0, "0", "false") else 1,
        "params": json.dumps(stored),
        "sites": json.dumps(keys),
    }, None


@bp.post("/searches")
def create_search():
    fields, err = _fields_from(request.get_json(silent=True) or {})
    if err:
        return fail(err)
    db = get_db()
    cur = db.execute(
        """INSERT INTO searches
               (name, site, query, sort, condition, category, min_price, max_price,
                notify, params, blocked_sellers, sites)
           VALUES (:name,:site,:query,:sort,:condition,:category,:min_price,:max_price,
                   :notify,:params,:blocked_sellers,:sites)""",
        fields)
    db.commit()
    row = db.execute("SELECT * FROM searches WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@bp.patch("/searches/<int:sid>")
def update_search(sid):
    """Edit a saved profile in place.

    The stored listings are deliberately kept: changing a price ceiling should
    not make everything already seen look new on the next run. Items that fall
    outside the new criteria simply stop coming back and get flagged `gone`.
    """
    db = get_db()
    row = db.execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    if not row:
        return fail("No such saved search.", 404)
    fields, err = _fields_from(request.get_json(silent=True) or {}, defaults=row)
    if err:
        return fail(err)
    db.execute(
        """UPDATE searches SET name=:name, site=:site, query=:query, sort=:sort,
               condition=:condition, category=:category, min_price=:min_price,
               max_price=:max_price, notify=:notify, params=:params,
               blocked_sellers=:blocked_sellers, sites=:sites
           WHERE id=:id""", {**fields, "id": sid})
    db.commit()
    return jsonify(dict(db.execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()))


@bp.post("/searches/<int:sid>/block")
def block_seller(sid):
    """Add (or with `unblock`, remove) one seller — what the ⊘ on a result card
    calls, so blocking is one click rather than a trip through the edit form."""
    body = request.get_json(silent=True) or {}
    seller = (body.get("seller") or "").strip().lstrip("@")
    if not seller:
        return fail("No seller given.")
    db = get_db()
    row = db.execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    if not row:
        return fail("No such saved search.", 404)

    current = parse_blocklist(row["blocked_sellers"] and json.loads(row["blocked_sellers"])) or []
    lowered = {s.lower() for s in current}
    if body.get("unblock"):
        current = [s for s in current if s.lower() != seller.lower()]
    elif seller.lower() not in lowered:
        current.append(seller)

    db.execute("UPDATE searches SET blocked_sellers=? WHERE id=?",
               (json.dumps(current), sid))
    # Hide anything already stored from that seller, so the list updates without
    # waiting for the next run.
    if not body.get("unblock"):
        db.execute("""UPDATE listings SET gone=1
                       WHERE search_id=? AND lower(substr(seller, 1, instr(seller || ' ', ' ') - 1))=?""",
                   (sid, seller.lower()))
    db.commit()
    return jsonify({"blocked_sellers": current})


@bp.get("/searches/<int:sid>")
def get_search(sid):
    row = get_db().execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    if not row:
        return fail("No such saved search.", 404)
    return jsonify(dict(row))


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
    keys = _sites_for(row)
    items, site_errors = aggregate.search_many(keys, _opts_for(row), _params_map(row))
    if site_errors and not items and len(site_errors) == len(keys):
        # Every site failed — nothing to diff, and storing "everything vanished"
        # would mark the whole history gone and then re-announce it all as new
        # on the next successful run.
        return jsonify({"error": "; ".join(e["error"] for e in site_errors),
                        "errors": site_errors}), 502

    # Filter before storing: a blocked seller should never enter the history,
    # so unblocking later does not announce their whole back catalogue as new.
    items, hidden = apply_blocklist(items, _blocked(row))

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
    #
    # Skipped for sites that errored: their listings are absent because we could
    # not ask, not because they sold. Marking them gone would make a throttled
    # Facebook look like every item vanished, then re-announce them all as new.
    failed = {e["site"] for e in site_errors}
    for r in db.execute("SELECT id, uid, url FROM listings WHERE search_id=? AND gone=0",
                        (sid,)).fetchall():
        if r["uid"] not in seen and r["uid"].split(":", 1)[0] not in failed:
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
        "hidden": hidden,
        "sites": keys,
        "errors": site_errors,
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
