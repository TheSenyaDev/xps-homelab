"""
Base class for notification channels.

A channel decides *where* a notification goes. It says which events it wants,
and formats a payload into a short human message; the event bus handles delivery
timing and swallows its errors.

Subclass, set `key`/`label`, implement `configured()` and `send()`:

    class Ntfy(Channel):
        key, label = "ntfy", "ntfy.sh"
        def configured(self):
            return bool(os.environ.get("NTFY_URL"))
        def send(self, title, body, links):
            requests.post(os.environ["NTFY_URL"], data=body.encode(), timeout=10)
"""

from __future__ import annotations

from ..events import subscribe


class Channel:
    key = ""
    label = ""

    #: Events this channel reacts to. Override to listen to more or fewer.
    events = ("listings.new", "listings.price_drop")

    registry: dict[str, type["Channel"]] = {}

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        if cls.key:
            Channel.registry[cls.key] = cls

    # ---- to implement ----

    def configured(self) -> bool:
        """True when this channel has what it needs (a URL, a token…). A channel
        that is not configured is skipped entirely rather than failing."""
        return False

    def send(self, title, body, links):
        raise NotImplementedError

    # ---- shared ----

    def install(self):
        for event in self.events:
            subscribe(event, self._make_handler(event))

    def _make_handler(self, event):
        def handler(payload):
            title, body, links = self.format(event, payload)
            if body:
                self.send(title, body, links)
        return handler

    def format(self, event, payload):
        """(title, body, links) from an event payload. Overridable, but the
        default is deliberately plain and works for both current events."""
        search = payload.get("search") or {}
        items = payload.get("listings") or []
        if not items:
            return "", "", []
        name = search.get("name") or search.get("query") or "search"
        kind = "new listing" if event == "listings.new" else "price drop"
        title = f"{len(items)} {kind}{'s' if len(items) != 1 else ''} — {name}"
        lines = []
        for it in items[:10]:
            price = it.get("price_text") or ""
            if event == "listings.price_drop" and it.get("was") is not None:
                price = f"{price} (was {it['was']})"
            lines.append(f"• {price} {it.get('title', '')}".strip())
        if len(items) > 10:
            lines.append(f"…and {len(items) - 10} more")
        return title, "\n".join(lines), [it.get("url", "") for it in items[:10]]
