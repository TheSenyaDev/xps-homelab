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
    """The search's blocklist as {site: {lowercased names}}.

    Scoped per marketplace because seller identities are not shared: "acme" on
    eBay is an account handle, "Acme" on Facebook is a person's display name,
    and they are unrelated. Blocking one should never silently block the other.

    Accepts the older flat list too, attributing it to the search's primary
    site, so blocklists saved before this existed keep working.
    """
    try:
        raw = json.loads(row["blocked_sellers"] or "{}")
    except (ValueError, TypeError, IndexError, KeyError):
        return {}
    if isinstance(raw, list):
        return {row["site"]: {str(x).strip().lower() for x in raw if str(x).strip()}}
    if not isinstance(raw, dict):
        return {}
    return {site: {str(x).strip().lower() for x in (names or []) if str(x).strip()}
            for site, names in raw.items()}


def _blocked_display(row):
    """Same, preserving original casing, for the edit form."""
    try:
        raw = json.loads(row["blocked_sellers"] or "{}")
    except (ValueError, TypeError, IndexError, KeyError):
        return {}
    if isinstance(raw, list):
        return {row["site"]: list(raw)}
    return raw if isinstance(raw, dict) else {}


def parse_names(value):
    """A free-typed string (commas/newlines) or a list -> deduped list."""
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


def parse_blocklist(value, sites_in_scope=None):
    """Normalise a blocklist payload to {site: [names]}.

    Accepts {site: "a, b"} from the per-market textareas, or a bare string/list
    which is attributed to the only site in scope — anything else would have to
    guess which marketplace a name belongs to.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        return {site: parse_names(names) or [] for site, names in value.items()}
    names = parse_names(value) or []
    if not names:
        return {}
    if sites_in_scope and len(sites_in_scope) == 1:
        return {sites_in_scope[0]: names}
    return {}


def apply_blocklist(items, blocked):
    """Split listings into (kept, hidden) by their own site's blocklist.

    Hidden ones are returned rather than counted so the UI can reveal them on
    demand — seeing what a block is actually costing you is how you notice it
    was too broad. They are still never stored (see run_search), so unblocking
    later cannot re-announce a seller's back catalogue as new.
    """
    if not blocked:
        return items, []
    kept, hidden = [], []
    for i in items:
        names = blocked.get(i.site) or set()
        (hidden if (i.seller_name or "").lower() in names else kept).append(i)
    return kept, hidden


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

    blocked = parse_blocklist(body.get("blocked_sellers"), keys)
    if blocked is None:                       # not mentioned → leave as-is
        blocked_json = d.get("blocked_sellers") or "{}"
    else:
        blocked_json = json.dumps({k: v for k, v in blocked.items() if v})

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
    """Block or unblock one seller, **on one marketplace**.

    What the ⊘ on a card and the button in the item panel call, so blocking is
    one click. `site` is required and not inferred: the same name on two
    marketplaces is two unrelated sellers.
    """
    body = request.get_json(silent=True) or {}
    seller = (body.get("seller") or "").strip().lstrip("@")
    site = (body.get("site") or "").strip()
    if not seller:
        return fail("No seller given.")
    if not site:
        return fail("No marketplace given — a seller is blocked per site.")

    db = get_db()
    row = db.execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    if not row:
        return fail("No such saved search.", 404)

    current = _blocked_display(row)
    names = list(current.get(site) or [])
    lowered = {n.lower() for n in names}
    if body.get("unblock"):
        names = [n for n in names if n.lower() != seller.lower()]
    elif seller.lower() not in lowered:
        names.append(seller)
    current[site] = names
    current = {k: v for k, v in current.items() if v}

    db.execute("UPDATE searches SET blocked_sellers=? WHERE id=?",
               (json.dumps(current), sid))
    if not body.get("unblock"):
        # Hide anything already stored from that seller on that site, so the
        # list updates without waiting for the next run.
        db.execute("""UPDATE listings SET gone=1
                       WHERE search_id=? AND uid LIKE ?
                         AND lower(substr(seller, 1, instr(seller || ' ', ' ') - 1))=?""",
                   (sid, f"{site}:%", seller.lower()))
    db.commit()
    return jsonify({"blocked_sellers": current, "site": site, "seller": seller})


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
    items, hidden_items = apply_blocklist(items, _blocked(row))

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
        "hidden": len(hidden_items),
        "blocked_listings": [i.as_dict() for i in hidden_items],
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
