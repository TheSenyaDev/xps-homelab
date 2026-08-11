"""
Saved searches as editable text.

A profile is a nested structure — markets, per-market criteria, per-market
options, per-market blocklists — and a form is a slow way to review or bulk-edit
one. This exposes the same profile as JSON that round-trips: what you read is
what is stored, and what you write goes through exactly the same validation the
form does, so the two cannot disagree.

`/validate` checks without saving, which is what the editor's Verify button
calls: it reports *where* the problem is (bad JSON with a line number, an unknown
market, an unknown sort for that market) rather than refusing with "invalid".
"""

from __future__ import annotations

import json

from flask import Blueprint, jsonify, request

from .. import sites
from ..db import get_db
from .searches import _fields_from, fail

bp = Blueprint("searchtext", __name__)

#: Column -> the key used in the text form. Only editable fields appear; id,
#: timestamps and the legacy single-site column are derived, not authored.
TEXT_FIELDS = ("name", "query", "min_price", "max_price", "notify")


def to_text(row):
    """The canonical text form of a stored row."""
    def load(col, default):
        try:
            v = json.loads(row[col] or "null")
            return v if v is not None else default
        except (ValueError, TypeError, IndexError, KeyError):
            return default

    doc = {
        "name": row["name"],
        "query": row["query"],
        "sites": load("sites", []) or [row["site"]],
        "min_price": row["min_price"],
        "max_price": row["max_price"],
        "notify": bool(row["notify"]),
        "criteria": load("criteria", {}),
        "params": load("params", {}),
        "blocked_sellers": load("blocked_sellers", {}),
    }
    return json.dumps(doc, indent=2, sort_keys=False)


def parse_text(text):
    """(payload, errors). Never raises — the editor wants the errors, not a 500."""
    errors = []
    try:
        doc = json.loads(text or "")
    except ValueError as e:
        # json's message already carries line/column, which is the useful part.
        return None, [f"Not valid JSON: {e}"]
    if not isinstance(doc, dict):
        return None, ["The top level must be an object: { \"name\": … }."]

    known = set(TEXT_FIELDS) | {"sites", "criteria", "params", "blocked_sellers"}
    for key in doc:
        if key not in known:
            errors.append(f"Unknown field {key!r}. Allowed: {', '.join(sorted(known))}.")

    site_keys = sites.keys()
    listed = doc.get("sites") or []
    if isinstance(listed, str):
        listed = [listed]
    if not isinstance(listed, list) or not listed:
        errors.append("\"sites\" must be a non-empty list, e.g. [\"ebay-ca\"] or [\"all\"].")
        listed = []
    for key in listed:
        if key != "all" and key not in site_keys:
            errors.append(f"Unknown market {key!r}. Available: {', '.join(site_keys)}.")

    effective = site_keys if "all" in listed else [k for k in listed if k in site_keys]

    # Per-market blocks may only mention markets this search covers, and a sort
    # must be one that market actually offers — the whole point of checking here
    # rather than letting it silently fall back at scrape time.
    for field in ("criteria", "params", "blocked_sellers"):
        block = doc.get(field)
        if block is None:
            continue
        if not isinstance(block, dict):
            errors.append(f"\"{field}\" must be an object keyed by market.")
            continue
        for key in block:
            if key not in effective:
                errors.append(
                    f"\"{field}\" mentions {key!r}, which is not in \"sites\".")

    for key, c in (doc.get("criteria") or {}).items():
        if key not in effective or not isinstance(c, dict):
            continue
        scraper = sites.get(key)
        wanted = c.get("sort")
        if wanted and wanted not in {s.key for s in scraper.sorts()}:
            offered = ", ".join(s.key for s in scraper.sorts())
            errors.append(f"{scraper.label} has no sort {wanted!r}. Offered: {offered}.")

    if not str(doc.get("query") or "").strip():
        errors.append("\"query\" is required.")

    return doc, errors


@bp.get("/searches/<int:sid>/text")
def read_text(sid):
    row = get_db().execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    if not row:
        return fail("No such saved search.", 404)
    return jsonify({"text": to_text(row)})


@bp.post("/searches/text/validate")
def validate_text():
    """Check without saving. Also returns the normalised form, so the editor can
    show what would actually be stored."""
    doc, errors = parse_text((request.get_json(silent=True) or {}).get("text", ""))
    if errors:
        return jsonify({"ok": False, "errors": errors})
    # Run the same validation the form does, so the two cannot disagree.
    fields, err = _fields_from(doc)
    if err:
        return jsonify({"ok": False, "errors": [err]})
    return jsonify({"ok": True, "errors": [],
                    "normalized": json.dumps(doc, indent=2)})


@bp.put("/searches/<int:sid>/text")
def write_text(sid):
    db = get_db()
    row = db.execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    if not row:
        return fail("No such saved search.", 404)
    doc, errors = parse_text((request.get_json(silent=True) or {}).get("text", ""))
    if errors:
        return jsonify({"ok": False, "errors": errors}), 400
    fields, err = _fields_from(doc, defaults=row)
    if err:
        return jsonify({"ok": False, "errors": [err]}), 400
    db.execute(
        """UPDATE searches SET name=:name, site=:site, query=:query, sort=:sort,
               condition=:condition, category=:category, min_price=:min_price,
               max_price=:max_price, notify=:notify, params=:params,
               blocked_sellers=:blocked_sellers, sites=:sites, criteria=:criteria
           WHERE id=:id""", {**fields, "id": sid})
    db.commit()
    updated = db.execute("SELECT * FROM searches WHERE id=?", (sid,)).fetchone()
    return jsonify({"ok": True, "errors": [], "text": to_text(updated)})
