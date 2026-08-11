"""
Site registry.

Every module in this package is imported on load, and every `Scraper` subclass
registers itself by existing (see `Scraper.__init_subclass__`). So adding a
marketplace is exactly one thing:

    scraper/sites/kijiji.py  →  class Kijiji(Scraper): key = "kijiji" ...

No list to update here, no import to add, no route to touch — the API and the UI
both build their site pickers from `available()`.

Adapters are instantiated once and reused: a `Scraper` holds a requests Session
whose cookies are what get us past bot protection, and a fresh instance per
search would throw that away and start collecting 403s.
"""

import importlib
import pkgutil

from .base import (Category, Listing, Scraper, ScrapeError, SearchOptions,
                   UnknownSite)

# Import every sibling module so its Scraper subclasses register themselves.
for _mod in pkgutil.iter_modules(__path__):
    if not _mod.name.startswith("_") and _mod.name != "base":
        importlib.import_module(f"{__name__}.{_mod.name}")

# key -> live instance, built once from whatever registered above.
_INSTANCES = {key: cls() for key, cls in Scraper.registry.items()}


def available():
    """[{key, label, supports, categories, …}] for the UI's site picker."""
    return [s.describe() for s in _INSTANCES.values()]


def keys():
    return list(_INSTANCES)


def get(key):
    scraper = _INSTANCES.get(key)
    if scraper is None:
        known = ", ".join(sorted(_INSTANCES)) or "none"
        raise UnknownSite(f"Unknown site '{key}'. Available: {known}.")
    return scraper


__all__ = ["Category", "Listing", "Scraper", "ScrapeError", "SearchOptions",
           "UnknownSite", "available", "get", "keys"]
