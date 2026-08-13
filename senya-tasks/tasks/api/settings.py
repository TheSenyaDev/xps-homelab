"""App preferences, as a key/value table.

Declared with their defaults and bounds so the API can validate without the
frontend re-stating them, and so an unknown key is rejected rather than stored.
"""
from flask import Blueprint, jsonify, request

from ..db import get_db

bp = Blueprint("settings", __name__, url_prefix="/api")

SETTINGS = {
    # How many completed tasks stay visible. Completed work is noise once it is
    # done, but hiding it entirely makes it look like the task vanished — a
    # couple of recent ones is the reassurance without the clutter.
    "completed_shown": {"default": 3, "min": 0, "max": 25, "type": "int",
                        "label": "Completed tasks shown",
                        "help": "Most recently completed stay visible; older "
                                "ones are hidden. 0 hides them all."},
}


def get_settings(db):
    stored = {r["key"]: r["value"]
              for r in db.execute("SELECT key, value FROM settings").fetchall()}
    out = {}
    for key, spec in SETTINGS.items():
        raw = stored.get(key, spec["default"])
        try:
            value = int(raw) if spec["type"] == "int" else raw
        except (TypeError, ValueError):
            value = spec["default"]
        if spec["type"] == "int":
            value = max(spec["min"], min(spec["max"], value))
        out[key] = value
    return out


@bp.get("/settings")
def read_settings():
    return jsonify({
        "values": get_settings(get_db()),
        "schema": [{"key": k, **{x: v for x, v in spec.items() if x != "default"},
                    "default": spec["default"]}
                   for k, spec in SETTINGS.items()],
    })


@bp.put("/settings")
def write_settings():
    body = request.get_json(silent=True) or {}
    db = get_db()
    for key, raw in body.items():
        spec = SETTINGS.get(key)
        if spec is None:
            continue                      # unknown keys are ignored, not stored
        if spec["type"] == "int":
            try:
                value = int(raw)
            except (TypeError, ValueError):
                return jsonify({"error": f"{key} must be a whole number."}), 400
            value = max(spec["min"], min(spec["max"], value))
        else:
            value = str(raw)
        db.execute("""INSERT INTO settings (key, value) VALUES (?, ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                   (key, str(value)))
    db.commit()
    return jsonify({"values": get_settings(db)})
