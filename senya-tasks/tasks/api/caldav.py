from flask import Blueprint, jsonify, request

import caldav
from ..db import connect, get_db
from ..validation import ApiError

bp = Blueprint("caldav_api", __name__)


@bp.get("/api/caldav")
def caldav_status():
    """Where sync stands: last run, how many tasks are mapped, pending deletes."""
    return jsonify(caldav.status(get_db()))


@bp.put("/api/caldav/config")
def caldav_save_config():
    """Save connection settings from the UI.

    The password is write-only: it is never returned by any endpoint, and an
    empty field means "keep the stored one" so re-saving other settings can't
    silently wipe it.
    """
    data = request.get_json(force=True, silent=True) or {}
    try:
        caldav.save_config(get_db(), data)
    except ValueError as e:
        raise ApiError(str(e))
    return jsonify(caldav.status(get_db()))


@bp.post("/api/caldav/test")
def caldav_test():
    """Check the settings against the real server without saving them."""
    data = request.get_json(force=True, silent=True) or {}
    return jsonify(caldav.test_connection(get_db(), data))


@bp.post("/api/caldav/sync")
def caldav_sync_now():
    """Run a pass immediately instead of waiting for the timer."""
    result = caldav.run_once(connect)
    if "skipped" in result:
        raise ApiError(f"sync not run: {result['skipped']}")
    return jsonify(result)
