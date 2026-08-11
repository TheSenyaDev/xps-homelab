"""
API blueprints, all mounted under /api.

Adding an endpoint group (categories, notification settings, run history) is a
new module here plus one line in `MODULES` — no edits to the app factory.
"""

from . import search, searches, settings, sites

#: Modules exposing a `bp` Blueprint.
MODULES = (sites, search, searches, settings)


def register(app, url_prefix="/api"):
    for mod in MODULES:
        app.register_blueprint(mod.bp, url_prefix=url_prefix)
