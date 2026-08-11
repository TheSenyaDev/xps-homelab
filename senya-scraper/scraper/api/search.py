"""Live search: scrape now, persist nothing.

Takes one site, a list of them, or "all". A multi-site search is deliberately
**not** all-or-nothing — see `scraper/aggregate.py`.
"""

from flask import Blueprint, jsonify, request

from .. import aggregate, sites

bp = Blueprint("search", __name__)


@bp.post("/search")
def search():
    body = request.get_json(silent=True) or {}
    opts = sites.SearchOptions.from_dict(body)
    if not opts.query:
        return jsonify({"error": "Enter something to search for."}), 400

    # `sites` (list or "all") is the current form; `site` remains accepted so
    # older callers and saved rows keep working.
    requested = body.get("sites") or body.get("site") or "ebay-ca"
    try:
        keys = aggregate.resolve(requested)
    except sites.UnknownSite as e:
        return jsonify({"error": str(e)}), 400

    # Per-site options arrive keyed by site for a multi-site search, or bare for
    # a single one — accept both so the single-site path stays simple.
    params = body.get("params") or {}
    by_site = params if all(k in keys for k in params) and params else {}
    if not by_site and params:
        by_site = {keys[0]: params} if len(keys) == 1 else {}

    listings, errors = aggregate.search_many(keys, opts, by_site)

    # Everything failed → report it as an upstream failure rather than an empty
    # shelf. Some failed → 200 with the partial results and the error list, so
    # one throttled marketplace never costs you the others.
    if errors and not listings and len(errors) == len(keys):
        return jsonify({"error": "; ".join(e["error"] for e in errors),
                        "errors": errors}), 502

    return jsonify({
        "count": len(listings),
        "sites": keys,
        "errors": errors,
        "results": [i.as_dict() for i in listings],
    })
