"""SenyaTasks — modular Flask app factory.

Layout:
  config.py          runtime config (paths, vocabularies)
  db.py               sqlite schema, migrations, connection handling
  validation.py       field validators + ApiError
  serialize.py         DB row -> API JSON
  markdown_export.py   Tasks.md (Obsidian-flavoured) export
  markdown_import.py   Obsidian markdown -> proposed tasks
  api/                 one Blueprint per feature area (tasks, categories, …)

caldav.py (CalDAV sync engine) stays at the repo root, not in this package —
it has no dependency on the Flask app and is imported the same way by both
this package and the test suite.
"""
from flask import Flask, jsonify, send_from_directory

import caldav

from .api import all_blueprints
from .db import close_db, connect, migrate
from .markdown_export import write_markdown
from .validation import ApiError


def create_app(static_dir):
    app = Flask(__name__, static_folder=None)
    app.teardown_appcontext(close_db)

    @app.errorhandler(ApiError)
    def handle_api_error(err):
        return jsonify({"error": err.message}), err.status

    for bp in all_blueprints():
        app.register_blueprint(bp)

    @app.get("/")
    def index():
        return send_from_directory(static_dir, "index.html")

    @app.get("/<path:path>")
    def static_files(path):
        return send_from_directory(static_dir, path)

    init_db()
    # Polls in its own thread with its own connection — never on the request path,
    # so an unreachable CalDAV server can't stall the API.
    caldav.start_worker(connect)

    return app


def init_db():
    conn = connect()
    # Migration 1 rebuilds `tasks`; with FK enforcement on, dropping it would
    # trip the categories reference mid-migration.
    conn.execute("PRAGMA foreign_keys = OFF")
    migrate(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    write_markdown(conn)
    # Settings saved from the UI override the env defaults.
    caldav.load_config(conn)
    conn.close()
