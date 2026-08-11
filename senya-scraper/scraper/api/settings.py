"""Runtime settings: read the schema + values, write changes.

The schema travels with the values so the page renders itself — adding a setting
never touches the frontend.
"""

from flask import Blueprint, jsonify, request

from .. import settings, sites

bp = Blueprint("settings", __name__)


@bp.get("/settings")
def read():
    return jsonify({
        "schema": [s.as_dict() for s in settings.STORE.schema()],
        "values": settings.STORE.all(),
    })


@bp.put("/settings")
def write():
    changed = settings.STORE.update(request.get_json(silent=True) or {})
    # Anything under http. or a market toggle changes how requests are made, so
    # rebuild now rather than leaving the running fetchers on stale settings.
    if any(k.startswith(("http.", "sites.")) for k in changed):
        sites.rebuild_fetchers()
    return jsonify({
        "changed": changed,
        "values": settings.STORE.all(),
        "fetchers": {k: sites.get(k).describe_fetcher() for k in sites.keys()},
    })
