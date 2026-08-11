"""What this install can scrape, and how it can be told about it."""

from flask import Blueprint, jsonify

from .. import notify, sites as site_registry

bp = Blueprint("sites", __name__)


@bp.get("/sites")
def list_sites():
    """Each entry carries its own `supports` flags and category list, so the UI
    renders the right controls per site instead of hard-coding eBay's."""
    return jsonify(site_registry.available())


@bp.get("/health")
def health():
    return jsonify({
        "sites": site_registry.keys(),
        "notify": notify.describe(),
    })
