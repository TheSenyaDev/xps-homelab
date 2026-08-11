"""
Transport backends.

The backend owns the two layers you cannot fake with headers alone:

* **TLS (JA3/JA4)** — the ClientHello's cipher order, extensions and curves.
  `requests`/`urllib3` produce a fingerprint that matches no browser in
  existence, and it is checked before a single byte of HTTP is parsed. Perfect
  headers do not help if this layer already said "Python".
* **HTTP/2** — SETTINGS frames, window sizes, and the pseudo-header order
  (`:method :authority :scheme :path`). `requests` cannot speak h2 at all, so a
  request claiming to be Chrome arrives over HTTP/1.1 — which real Chrome never
  does, and which is encoded directly in the JA4 string (`...h1_` vs `...h2_`).

`CurlBackend` handles both by impersonating a real browser's stack.
`RequestsBackend` exists so the app still runs if curl_cffi is unavailable, and
says clearly that it is the weaker option rather than pretending otherwise.

Adding a backend (a proxy pool, a headless browser) is a class here plus an
entry in `BACKENDS`; `select()` picks the best available.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


class Backend:
    """Wraps one HTTP client behind a small, uniform surface."""

    key = ""
    label = ""
    #: Whether this backend actually forges TLS/HTTP2 fingerprints. Surfaced in
    #: /api/health so "am I fingerprintable as Python?" is answerable.
    impersonates = False

    @classmethod
    def available(cls):
        return False

    def __init__(self, profile, proxy=None, verify=True):
        self.profile = profile
        self.proxy = proxy
        self.verify = verify

    def request(self, method, url, headers=None, timeout=25, allow_redirects=True):
        raise NotImplementedError

    # Cookie access, so the fetcher can persist a jar without caring which
    # client is underneath.
    def cookies(self) -> dict:
        raise NotImplementedError

    def set_cookies(self, mapping, domain):
        raise NotImplementedError

    def close(self):
        pass


class CurlBackend(Backend):
    """curl_cffi — impersonates a real browser's TLS and HTTP/2 fingerprints."""

    key = "curl_cffi"
    label = "curl_cffi (TLS + HTTP/2 impersonation)"
    impersonates = True

    @classmethod
    def available(cls):
        try:
            import curl_cffi  # noqa: F401
            return True
        except ImportError:
            return False

    def __init__(self, profile, proxy=None, verify=True):
        super().__init__(profile, proxy, verify)
        from curl_cffi import requests as cr
        self._cr = cr
        # The session holds the connection pool and cookie jar; reusing it also
        # means TLS session resumption, which is itself browser-like.
        self.session = cr.Session(
            impersonate=profile.impersonate,
            proxies={"http": proxy, "https": proxy} if proxy else None,
            verify=verify,
        )

    def request(self, method, url, headers=None, timeout=25, allow_redirects=True):
        # `impersonate` sets a browser-shaped default header set; passing ours
        # replaces the ones we name and keeps our ordering for those.
        return self.session.request(
            method, url, headers=headers, timeout=timeout,
            allow_redirects=allow_redirects,
        )

    def cookies(self):
        return {c.name: c.value for c in self.session.cookies.jar}

    def set_cookies(self, mapping, domain):
        for name, value in mapping.items():
            try:
                self.session.cookies.set(name, value, domain=domain)
            except Exception:                       # noqa: BLE001
                log.debug("could not restore cookie %s", name)

    def close(self):
        try:
            self.session.close()
        except Exception:                           # noqa: BLE001
            pass


class RequestsBackend(Backend):
    """Plain `requests`. Correct headers, but a Python TLS fingerprint and
    HTTP/1.1 — kept only so the app degrades instead of failing to start."""

    key = "requests"
    label = "requests (no TLS impersonation)"
    impersonates = False

    @classmethod
    def available(cls):
        try:
            import requests  # noqa: F401
            return True
        except ImportError:
            return False

    def __init__(self, profile, proxy=None, verify=True):
        super().__init__(profile, proxy, verify)
        import requests
        self.session = requests.Session()
        if proxy:
            self.session.proxies.update({"http": proxy, "https": proxy})
        self.session.verify = verify

    def request(self, method, url, headers=None, timeout=25, allow_redirects=True):
        return self.session.request(method, url, headers=headers, timeout=timeout,
                                    allow_redirects=allow_redirects)

    def cookies(self):
        return dict(self.session.cookies)

    def set_cookies(self, mapping, domain):
        for name, value in mapping.items():
            self.session.cookies.set(name, value, domain=domain)

    def close(self):
        self.session.close()


#: Best first — `select()` returns the first available.
BACKENDS = [CurlBackend, RequestsBackend]


def select(preferred=None):
    """The best backend available, or `preferred` if it is usable."""
    if preferred:
        for b in BACKENDS:
            if b.key == preferred and b.available():
                return b
        log.warning("backend %r unavailable; falling back", preferred)
    for b in BACKENDS:
        if b.available():
            if not b.impersonates:
                log.warning(
                    "using %s: no TLS/HTTP2 impersonation, so requests are "
                    "fingerprintable as Python. Install curl_cffi.", b.label)
            return b
    raise RuntimeError("no HTTP backend available")
