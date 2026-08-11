"""
SenyaScraper — marketplace product search for the homelab.

Searches second-hand marketplaces from one box and, for searches you save, tells
you what changed since last time: which listings are new and which dropped in
price. That diff is the point — running the same eBay search by hand every day
and trying to spot what moved is exactly the job a computer should do.

    browser ──► api/ ──► sites/<site>.py ──► the marketplace
                 │
                 ├─► db.py      SQLite: saved searches + every listing ever seen
                 └─► events.py ──► notify/<channel>.py

Each layer is extended by adding a file, not by editing a hub:

    another marketplace   scraper/sites/<name>.py     (self-registering)
    another notifier      scraper/notify/<name>.py    (self-registering)
    another endpoint      scraper/api/<name>.py       + one line in api/__init__
    a schema change       append to db.MIGRATIONS
"""

from __future__ import annotations

import logging
import os

from flask import Flask, send_from_directory

from . import db, notify

__version__ = "0.1.0"

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


def create_app(config=None):
    """Application factory — so tests can build an app on a temp database
    without the import side effects a module-level `app = Flask(...)` causes."""
    app = Flask(__name__, static_folder=None)
    app.config["DB_PATH"] = os.environ.get("DB_PATH", db.DEFAULT_DB_PATH)
    app.config["STATIC_DIR"] = STATIC_DIR
    if config:
        app.config.update(config)

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    db.init_app(app)

    # Imported here, not at module scope: registering blueprints pulls in the
    # site adapters, and those should load against a configured app.
    from . import api
    api.register(app)

    channels = notify.install()
    app.logger.info("notify channels active: %s",
                    ", ".join(c.key for c in channels) or "none")

    _register_static(app)
    return app


def _register_static(app):
    """Serve the frontend from /. Kept last so /api/* always wins."""

    @app.get("/")
    def index():
        return send_from_directory(app.config["STATIC_DIR"], "index.html")

    @app.get("/<path:path>")
    def static_files(path):
        return send_from_directory(app.config["STATIC_DIR"], path)
