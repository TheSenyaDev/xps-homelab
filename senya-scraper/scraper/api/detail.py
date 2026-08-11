"""
Listing detail: fetch one item's own page for the parts a search result omits.

Search results carry a title, price and thumbnail — never a description. Getting
one costs an extra request to the marketplace, so it happens on demand when an
item is opened rather than for every result in a list, which would multiply
every search by 60 and get the account throttled immediately.
"""

from flask import Blueprint, jsonify, request

from .. import sites

bp = Blueprint("detail", __name__)


@bp.post("/detail")
def detail():
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    site = (body.get("site") or "").strip()
    if not url or not site:
        return jsonify({"error": "Need a site and a url."}), 400
    try:
        scraper = sites.get(site)
    except sites.UnknownSite as e:
        return jsonify({"error": str(e)}), 400
    if not scraper.supports_detail:
        return jsonify({"error": f"{scraper.label} has no detail fetcher yet.",
                        "unsupported": True}), 501
    # Only ever fetch from the site that owns the listing — a url from the
    # request must not be able to point this at an arbitrary host.
    if scraper.domain not in url:
        return jsonify({"error": "That url does not belong to that site."}), 400
    try:
        return jsonify(scraper.fetch_detail(url))
    except sites.ScrapeError as e:
        return jsonify({"error": str(e)}), 502
