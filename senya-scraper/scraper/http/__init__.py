"""
Browser-shaped HTTP.

Everything about *looking like a person* lives here, and nothing about any
particular marketplace does — so adapters describe sites, not evasion, and
improving realism improves every site at once.

    profiles.py   one coherent browser identity (TLS target + UA + hints + order)
    backends.py   the transport, which owns TLS/JA3 and HTTP/2 fingerprints
    fetcher.py    pacing, cookies, warm-up, Referer chains, retries, detection

Typical use, from an adapter:

    from ..http import FetchPolicy

    class Kijiji(Scraper):
        policy = FetchPolicy(profile="chrome-win", min_interval=3,
                             max_interval=9, warmup_url="https://www.kijiji.ca/")

Extending it:
    another browser    → an entry in profiles.PROFILES
    another transport  → a Backend subclass in backends.BACKENDS
    another knob       → a field on FetchPolicy plus the line that reads it
"""

from .backends import BACKENDS, Backend, select as select_backend
from .fetcher import BlockedError, FetchError, FetchPolicy, Fetcher, build
from .profiles import DEFAULT_PROFILE, PROFILES, BrowserProfile

__all__ = [
    "BACKENDS", "Backend", "select_backend",
    "BlockedError", "FetchError", "FetchPolicy", "Fetcher", "build",
    "DEFAULT_PROFILE", "PROFILES", "BrowserProfile",
]


def describe():
    """What this install can do, for /api/health."""
    chosen = select_backend()
    return {
        "backend": chosen.key,
        "backend_label": chosen.label,
        "impersonates_tls": chosen.impersonates,
        "available_backends": [b.key for b in BACKENDS if b.available()],
        "profiles": [{"key": p.key, "label": p.label, "tls": p.impersonate}
                     for p in PROFILES.values()],
    }
