"""
A tiny synchronous event bus.

The point is to keep "something happened" separate from "who cares". A saved
search run emits `listings.new`; whether that becomes a push notification, an
email, a webhook or nothing at all is decided by whatever subscribed, and the
run code never learns about any of it.

Subscribers must not raise: an event is a side channel, and a broken notifier
should never fail the search that triggered it. `emit` enforces that.

    from .events import emit, on

    @on("listings.new")
    def notify(payload): ...

Events currently emitted:
    listings.new          {search, listings}   items never seen for this search
    listings.price_drop   {search, listings}   items whose price fell since last run
"""

from __future__ import annotations

import logging
from collections import defaultdict

log = logging.getLogger(__name__)

_SUBSCRIBERS: dict[str, list] = defaultdict(list)


def on(event):
    """Decorator: register a handler for `event`."""
    def wrap(fn):
        subscribe(event, fn)
        return fn
    return wrap


def subscribe(event, fn):
    _SUBSCRIBERS[event].append(fn)


def emit(event, payload):
    """Call every subscriber. Exceptions are logged and swallowed — see above.

    Synchronous on purpose: a homelab app runs one gunicorn worker, the handlers
    are expected to be quick (a webhook POST), and a background queue would be
    machinery with nothing to do yet. Swap the loop for a queue push here if a
    handler ever gets slow; nothing else has to change.
    """
    for fn in _SUBSCRIBERS.get(event, ()):
        try:
            fn(payload)
        except Exception:
            log.exception("event handler for %s failed", event)


def subscribers(event=None):
    """Introspection, for tests and a future /api/health."""
    if event is not None:
        return list(_SUBSCRIBERS.get(event, ()))
    return {k: list(v) for k, v in _SUBSCRIBERS.items()}
