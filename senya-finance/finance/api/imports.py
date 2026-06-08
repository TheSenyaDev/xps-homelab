import os

from flask import Blueprint, current_app, jsonify

from ..db import get_db
from ..ingest import run_import

bp = Blueprint("imports", __name__, url_prefix="/api")


@bp.post("/import")
def trigger_import():
    result = run_import(get_db(), current_app.config["IMPORT_DIR"])
    return jsonify(result)


@bp.get("/import/status")
def import_status():
    import_dir = current_app.config["IMPORT_DIR"]
    csv_count = 0
    if os.path.isdir(import_dir):
        for _dp, _d, files in os.walk(import_dir):
            csv_count += sum(1 for f in files if f.lower().endswith(".csv"))
    tx_count = get_db().execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    return jsonify({
        "import_dir": import_dir,
        "import_dir_exists": os.path.isdir(import_dir),
        "csv_files": csv_count,
        "transactions": tx_count,
    })
