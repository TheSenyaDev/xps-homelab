"""API blueprints. Register a new feature by adding a module here exposing a
`bp` Blueprint and listing it in `all_blueprints()`."""
from .caldav import bp as caldav_bp
from .categories import bp as categories_bp
from .export import bp as export_bp
from .imports import bp as imports_bp
from .meta import bp as meta_bp
from .settings import bp as settings_bp
from .tags import bp as tags_bp
from .tasks import bp as tasks_bp


def all_blueprints():
    return [meta_bp, settings_bp, categories_bp, tags_bp, tasks_bp,
            export_bp, imports_bp, caldav_bp]
