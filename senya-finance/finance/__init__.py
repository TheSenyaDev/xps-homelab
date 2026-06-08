"""SenyaFinance — modular Flask app factory.

Layout:
  config.py      runtime config (paths, flags)
  db.py          sqlite schema + seed + connection
  categorize.py  rule engine (pure functions)
  ingest/        pluggable bank-statement parsers + import orchestrator
  api/           one Blueprint per feature area (transactions, categories, …)
  static/        ES-module frontend
"""
from flask import Flask, send_from_directory

from .api import all_blueprints
from .config import Config
from .db import close_db, get_db, init_db
from .ingest import run_import


def create_app(config=Config):
    app = Flask(__name__, static_folder="static", static_url_path="")
    app.config.from_object(config)

    init_db(app)
    app.teardown_appcontext(close_db)

    for bp in all_blueprints():
        app.register_blueprint(bp)

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    if app.config.get("AUTO_IMPORT"):
        _auto_import(app)

    return app


def _auto_import(app):
    """Import once on first boot (empty DB), so the app has data out of the box."""
    with app.app_context():
        try:
            db = get_db()
            if db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0:
                result = run_import(db, app.config["IMPORT_DIR"])
                app.logger.info("auto-import: %s", result)
        except Exception as exc:  # never block startup on import problems
            app.logger.warning("auto-import skipped: %s", exc)
