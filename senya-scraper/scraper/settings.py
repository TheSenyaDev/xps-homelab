"""
Runtime settings.

Declared as a schema rather than hard-coded into a form, for the same reason
site options are: the UI renders whatever is registered, so adding a setting is
one entry here and nothing else changes.

Stored as JSON in /data next to the database. A file rather than a table because
these are a handful of scalars, they want to be hand-editable when something is
misconfigured badly enough that the UI will not load, and they need no history.

Changing anything under `http.` rebuilds the site fetchers, so a new profile or
pace takes effect on the next request instead of the next restart.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

DEFAULT_PATH = os.environ.get("SETTINGS_PATH", "/data/settings.json")


@dataclass(frozen=True)
class Setting:
    """One control. `type` is bool · choice · number · text, matching the
    renderer the site options already use."""

    key: str
    label: str
    type: str = "bool"
    default: object = None
    choices: tuple = ()
    help: str = ""
    group: str = "General"
    #: Cosmetic only — no effect until something reads it. Marked so the page
    #: can say so rather than implying a dead switch does something.
    inert: bool = False

    def as_dict(self):
        return {"key": self.key, "label": self.label, "type": self.type,
                "default": self.default, "help": self.help, "group": self.group,
                "choices": [{"value": v, "label": l} for v, l in self.choices],
                "inert": self.inert}

    def coerce(self, value):
        if value is None:
            return self.default
        if self.type == "bool":
            return value not in (False, 0, "0", "false", "", None)
        if self.type == "number":
            try:
                return float(value)
            except (TypeError, ValueError):
                return self.default
        if self.type == "choice":
            allowed = {v for v, _ in self.choices}
            return value if value in allowed else self.default
        return str(value).strip()


def _profile_choices():
    # Imported lazily: scraper.http imports nothing from here, and keeping it
    # that way avoids a cycle.
    from .http import PROFILES
    return tuple((p.key, p.label) for p in PROFILES.values())


SCHEMA: list[Setting] = [
    # ---- fingerprint ----
    Setting("http.backend", "Transport", "choice",
            default="auto", group="Fingerprint",
            choices=(("auto", "Best available"),
                     ("curl_cffi", "curl_cffi — impersonate a browser"),
                     ("requests", "requests — no impersonation")),
            help="curl_cffi forges the TLS (JA3/JA4) and HTTP/2 fingerprints. "
                 "Plain requests is identifiable as Python before a byte of "
                 "HTTP is parsed."),
    Setting("http.profile", "Browser profile", "choice",
            default="chrome-mac", group="Fingerprint",
            choices=(),   # filled at runtime from the profile registry
            help="Sets the TLS target, User-Agent, client hints and header "
                 "order together, so no layer contradicts another."),

    # ---- pacing ----
    Setting("http.jitter", "Jittered pacing", "bool", default=True,
            group="Pacing",
            help="Vary the gap between requests. A fixed delay is itself a "
                 "signature — people do not click at exact intervals."),
    Setting("http.pace_multiplier", "Pace multiplier", "number", default=1.0,
            group="Pacing",
            help="Scales every site's gaps. Raise it when a site starts "
                 "throttling; 2 means twice as slow."),
    Setting("http.retries", "Retries", "number", default=2, group="Pacing",
            help="Retries on transport errors, with doubling backoff. Block "
                 "pages are never retried — that only deepens the hole."),

    # ---- session ----
    Setting("http.warmup", "Warm-up navigation", "bool", default=True,
            group="Session",
            help="Load the homepage before the first search, as a person "
                 "would. eBay and Facebook both refuse cold deep links."),
    Setting("http.referer_chain", "Referer chains", "bool", default=True,
            group="Session",
            help="Send Referer and Sec-Fetch-Site: same-origin once the "
                 "session is genuinely warm."),
    Setting("http.persist_cookies", "Persist cookies", "bool", default=True,
            group="Session",
            help="Keep cookie jars between restarts. A brand-new jar every "
                 "start is a signal no real browser sends."),
    Setting("http.proxy", "Proxy URL", "text", default="", group="Session",
            help="Optional, e.g. http://host:port. Leave blank to use this "
                 "machine's connection — a residential IP is worth more than "
                 "any other trick here."),

    # ---- behaviour ----
    Setting("search.parallel", "Search markets in parallel", "bool",
            default=True, group="Search",
            help="Query every selected market at once. The pacer is "
                 "per-domain, so this is no less polite to any single site."),
    Setting("search.fail_soft", "Keep partial results", "bool", default=True,
            group="Search",
            help="A blocked market returns an error beside the results from "
                 "the others, instead of failing the whole search."),
]

#: Sites can be turned off without deleting saved searches — appended at import
#: so the list follows whatever adapters are installed.
def _site_settings():
    from . import sites
    return [Setting(f"sites.{s['key']}.enabled", f"{s['label']}", "bool",
                    default=True, group="Markets",
                    help=f"Turn off to skip {s['label']} in every search.")
            for s in sites.available()]


class Store:
    """Settings values, with defaults applied and writes made atomic."""

    def __init__(self, path=None):
        self.path = path or DEFAULT_PATH
        self._lock = threading.Lock()
        self._values = {}
        self._schema = None
        self.load()

    # ---- schema ----

    def schema(self):
        """The full schema, cached once it can be built completely.

        The Markets section is derived from the site registry, and the adapters
        ask for settings *while* that registry is still importing — so the
        site-dependent part is attempted, skipped if not ready, and the result
        is only cached once it is whole. Without this the first adapter to build
        a fetcher deadlocks the import on a half-initialised module.
        """
        if self._schema is not None:
            return self._schema
        items = []
        for s in SCHEMA:
            if s.key == "http.profile":
                s = Setting(**{**s.__dict__, "choices": _profile_choices()})
            items.append(s)
        try:
            items.extend(_site_settings())
        except (ImportError, AttributeError):
            return items                    # not cached: retried once ready
        self._schema = items
        return self._schema

    def by_key(self):
        return {s.key: s for s in self.schema()}

    # ---- values ----

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
            self._values = data if isinstance(data, dict) else {}
        except FileNotFoundError:
            self._values = {}
        except (OSError, ValueError):
            # A corrupt file must not stop the app booting; defaults are fine.
            log.warning("settings at %s unreadable, using defaults", self.path)
            self._values = {}

    def save(self):
        with self._lock:
            try:
                os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
                tmp = f"{self.path}.tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(self._values, fh, indent=2, sort_keys=True)
                os.replace(tmp, self.path)      # atomic; never a half file
            except OSError:
                log.exception("could not save settings")

    def get(self, key, fallback=None):
        spec = self.by_key().get(key)
        if spec is None:
            return self._values.get(key, fallback)
        return spec.coerce(self._values.get(key, spec.default))

    def all(self):
        return {s.key: self.get(s.key) for s in self.schema()}

    def update(self, incoming):
        """Apply a partial dict, ignoring anything not in the schema. Returns
        the keys that actually changed, so callers know whether to rebuild."""
        known = self.by_key()
        changed = []
        for key, raw in (incoming or {}).items():
            spec = known.get(key)
            if spec is None:
                continue
            value = spec.coerce(raw)
            if self.get(key) != value:
                self._values[key] = value
                changed.append(key)
        if changed:
            self.save()
        return changed


STORE = Store()


def get(key, fallback=None):
    return STORE.get(key, fallback)


def enabled_sites(keys):
    """Filter a site list by the Markets toggles."""
    return [k for k in keys if get(f"sites.{k}.enabled", True)]


def apply_to(policy, *, domain=None):
    """Overlay the user's settings onto an adapter's FetchPolicy.

    The adapter still owns its own baseline — Facebook needs longer gaps than
    eBay regardless of preference — and these scale or override it rather than
    replacing it wholesale.
    """
    import dataclasses

    mult = max(0.1, float(get("http.pace_multiplier", 1.0) or 1.0))
    backend = get("http.backend", "auto")
    changes = {
        "profile": get("http.profile", policy.profile),
        "backend": None if backend == "auto" else backend,
        "min_interval": policy.min_interval * mult,
        "max_interval": (policy.max_interval or policy.min_interval * 3) * mult
                        if get("http.jitter", True) else None,
        "retries": int(get("http.retries", 2) or 0),
        "referer_chain": bool(get("http.referer_chain", True)),
        "proxy": get("http.proxy", "") or None,
    }
    if not get("http.warmup", True):
        changes["warmup_url"] = ""
    if not get("http.persist_cookies", True):
        changes["cookie_file"] = ""
    return dataclasses.replace(policy, **changes)
