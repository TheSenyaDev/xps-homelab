"""Live search: scrape now, persist nothing."""

from flask import Blueprint, jsonify, request

from .. import sites

bp = Blueprint("search", __name__)


@bp.post("/search")
def search():
    body = request.get_json(silent=True) or {}
    opts = sites.SearchOptions.from_dict(body)
    if not opts.query:
        return jsonify({"error": "Enter something to search for."}), 400
    try:
        items = sites.get(body.get("site") or "ebay-ca").search(opts)
    except sites.UnknownSite as e:
        return jsonify({"error": str(e)}), 400
    except sites.ScrapeError as e:
        # Upstream refused or changed shape — not a bug in this service.
        return jsonify({"error": str(e)}), 502
    return jsonify({"count": len(items), "results": [i.as_dict() for i in items]})
