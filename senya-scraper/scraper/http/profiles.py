"""
Browser profiles: one coherent identity per entry.

A profile is only useful if every layer agrees. Claiming Chrome 131 in the
User-Agent while presenting Chrome 124's TLS handshake, or sending
`Sec-Ch-Ua-Platform: "Windows"` with a macOS UA, is *more* identifying than
sending nothing — real traffic is never self-contradictory, so a mismatch is a
signal in itself. Bundling the TLS target, the UA, the client hints and the
platform into one object makes that kind of drift hard to introduce by accident.

Adding a profile is one entry in `PROFILES`. Nothing else changes: the fetcher,
the backends and every adapter read whatever is registered.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class BrowserProfile:
    """One browser, described consistently across every layer we can control."""

    key: str
    label: str

    #: curl_cffi impersonation target — drives the TLS (JA3/JA4) handshake and
    #: the HTTP/2 SETTINGS/pseudo-header fingerprint. Must name the same browser
    #: version as `user_agent`.
    impersonate: str

    user_agent: str
    platform: str                      # Sec-Ch-Ua-Platform value, quoted below
    sec_ch_ua: str = ""                # "" for browsers that send no hints
    accept_language: str = "en-CA,en;q=0.9"
    mobile: bool = False

    #: Emitted in this order. Header *order* is itself a fingerprint: browsers
    #: are stable and consistent, dict iteration is not. Python dicts preserve
    #: insertion order, so building from this list is enough.
    header_order: tuple = (
        "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
        "upgrade-insecure-requests", "user-agent", "accept",
        "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest",
        "accept-encoding", "accept-language",
    )

    accept_html: str = ("text/html,application/xhtml+xml,application/xml;q=0.9,"
                        "image/avif,image/webp,image/apng,*/*;q=0.8,"
                        "application/signed-exchange;v=b3;q=0.7")
    accept_encoding: str = "gzip, deflate, br, zstd"
    extra: dict = field(default_factory=dict)

    def headers(self, *, navigation=True, site="none", referer=None):
        """Headers for one request, in this browser's own order.

        `site` is the Sec-Fetch-Site value: "none" for something you typed in the
        address bar, "same-origin" when following a link within the site. Getting
        this wrong is a classic tell — a search results page reached with
        `Sec-Fetch-Site: none` and no Referer is not something a browser does.
        """
        h = {}
        for name in self.header_order:
            if name == "sec-ch-ua":
                if self.sec_ch_ua:
                    h["sec-ch-ua"] = self.sec_ch_ua
            elif name == "sec-ch-ua-mobile":
                if self.sec_ch_ua:
                    h["sec-ch-ua-mobile"] = "?1" if self.mobile else "?0"
            elif name == "sec-ch-ua-platform":
                if self.sec_ch_ua:
                    h["sec-ch-ua-platform"] = f'"{self.platform}"'
            elif name == "upgrade-insecure-requests":
                if navigation:
                    h["upgrade-insecure-requests"] = "1"
            elif name == "user-agent":
                h["user-agent"] = self.user_agent
            elif name == "accept":
                h["accept"] = self.accept_html
            elif name == "sec-fetch-site":
                h["sec-fetch-site"] = site
            elif name == "sec-fetch-mode":
                h["sec-fetch-mode"] = "navigate" if navigation else "cors"
            elif name == "sec-fetch-user":
                # Only present when the navigation was user-initiated, which is
                # exactly what we are pretending. Absent on subresource loads.
                if navigation:
                    h["sec-fetch-user"] = "?1"
            elif name == "sec-fetch-dest":
                h["sec-fetch-dest"] = "document" if navigation else "empty"
            elif name == "accept-encoding":
                h["accept-encoding"] = self.accept_encoding
            elif name == "accept-language":
                h["accept-language"] = self.accept_language
        if referer:
            # Chrome places Referer after the Sec-Fetch block.
            h["referer"] = referer
        h.update(self.extra)
        return h


# Chrome's UA has been frozen at "10_15_7" / "Windows NT 10.0" for years; those
# strings are correct, not stale.
_CHROME_UA_MAC = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36")
_CHROME_UA_WIN = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36")
_CHROME_CH = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'

PROFILES = {
    p.key: p for p in [
        BrowserProfile(
            key="chrome-mac", label="Chrome 124 · macOS",
            impersonate="chrome124", user_agent=_CHROME_UA_MAC,
            platform="macOS", sec_ch_ua=_CHROME_CH,
        ),
        BrowserProfile(
            key="chrome-win", label="Chrome 124 · Windows",
            impersonate="chrome124", user_agent=_CHROME_UA_WIN,
            platform="Windows", sec_ch_ua=_CHROME_CH,
        ),
        BrowserProfile(
            key="safari-mac", label="Safari 17 · macOS",
            impersonate="safari17_0",
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                        "Version/17.0 Safari/605.1.15"),
            platform="macOS",
            # Safari sends no Client Hints at all — including them would be the
            # contradiction this module exists to prevent.
            sec_ch_ua="",
            accept_html=("text/html,application/xhtml+xml,application/xml;q=0.9,"
                         "*/*;q=0.8"),
            accept_encoding="gzip, deflate, br",
            header_order=("accept", "sec-fetch-site", "sec-fetch-mode",
                          "sec-fetch-dest", "user-agent", "accept-language",
                          "accept-encoding"),
        ),
        BrowserProfile(
            key="chrome-android", label="Chrome · Android",
            impersonate="chrome99_android",
            user_agent=("Mozilla/5.0 (Linux; Android 12; Pixel 6) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Mobile Safari/537.36"),
            platform="Android", sec_ch_ua=_CHROME_CH, mobile=True,
        ),
    ]
}

DEFAULT_PROFILE = "chrome-mac"


def get(key=None):
    return PROFILES.get(key or DEFAULT_PROFILE) or PROFILES[DEFAULT_PROFILE]


def keys():
    return list(PROFILES)
