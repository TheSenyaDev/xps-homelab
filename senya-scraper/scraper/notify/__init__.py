"""
Notification channels.

Same shape as `scraper.sites`: every module in this package is imported on load,
and every `Channel` subclass registers itself by existing. Adding a way to be
told about new listings is one new file here — no wiring, no route changes.

A channel is enabled only if its `configured()` says so (normally "is my env var
set?"), which keeps an unconfigured homelab silent instead of erroring.

    scraper/notify/ntfy.py  →  class Ntfy(Channel): key = "ntfy" ...

Channels subscribe to the events in `scraper.events`; see `log.py` for the
smallest possible example.
"""

import importlib
import pkgutil

from .base import Channel

for _mod in pkgutil.iter_modules(__path__):
    if not _mod.name.startswith("_") and _mod.name != "base":
        importlib.import_module(f"{__name__}.{_mod.name}")

_INSTANCES = [cls() for cls in Channel.registry.values()]


def active():
    """Channels that are configured and will actually fire."""
    return [c for c in _INSTANCES if c.configured()]


def describe():
    """[{key, label, configured}] — for a settings screen or /api/health."""
    return [{"key": c.key, "label": c.label, "configured": c.configured()}
            for c in _INSTANCES]


def install():
    """Wire every configured channel to the event bus. Called once by create_app."""
    for channel in active():
        channel.install()
    return active()


__all__ = ["Channel", "active", "describe", "install"]
