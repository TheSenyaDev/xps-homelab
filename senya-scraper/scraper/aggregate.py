"""
Searching several marketplaces at once and merging the results.

Two things make this more than a loop:

**Partial failure is normal.** These sites throttle independently, so one being
blocked while the others answer is the expected case, not an edge case. A
combined search therefore never fails as a whole — it returns whatever came back
plus a per-site error list, and the UI says which sites are missing. Failing
everything because Facebook is sulking would make the feature useless.

**Ranks do not merge.** Each site returns its own idea of order, and there is no
shared scale — eBay's "best match" and Facebook's relevance are not comparable,
and eBay listings carry no post date at all. So the merge strategy depends on
what was actually asked for; see `merge()`.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from . import sites as site_registry

log = logging.getLogger(__name__)

#: What the API accepts to mean "every site this install has".
ALL = "all"


def resolve(requested):
    """Normalise whatever the caller asked for into a list of site keys.

    Accepts a single key, a list, or ALL. Unknown keys raise, rather than being
    dropped: silently searching fewer sites than asked would misreport an empty
    result as "nothing for sale".
    """
    if not requested:
        return [site_registry.keys()[0]] if site_registry.keys() else []
    if isinstance(requested, str):
        requested = [requested]
    if ALL in requested:
        return site_registry.keys()
    out = []
    for key in requested:
        site_registry.get(key)          # raises UnknownSite
        if key not in out:
            out.append(key)
    return out


def search_many(keys, opts, params_by_site=None, timeout=120):
    """Search every site in `keys`, in parallel.

    Returns (listings, errors) where errors is [{site, label, error}].

    Parallel because the rate limiter is per-domain: hitting two marketplaces at
    once is no less polite to either, and serialising them would make a combined
    search as slow as its slowest member plus everything else. Facebook alone
    holds a 6 s floor.
    """
    params_by_site = params_by_site or {}
    results, errors = {}, []

    def run(key):
        scraper = site_registry.get(key)
        # Each site gets only its own options — the whole point of storing them
        # keyed by site.
        site_opts = opts.replace(params=params_by_site.get(key, {}))
        return scraper.search(site_opts)

    if not keys:
        return [], []

    with ThreadPoolExecutor(max_workers=min(len(keys), 8)) as pool:
        futures = {pool.submit(run, k): k for k in keys}
        for future, key in futures.items():
            label = site_registry.get(key).label
            try:
                results[key] = future.result(timeout=timeout)
            except site_registry.ScrapeError as e:
                # Expected: throttling, a bot check, markup drift. Report it
                # against its site and keep the others.
                errors.append({"site": key, "label": label, "error": str(e)})
            except Exception as e:                      # noqa: BLE001
                # Unexpected: a bug in an adapter. Still must not take down the
                # sites that worked, but log it properly rather than swallowing.
                log.exception("adapter %s raised", key)
                errors.append({"site": key, "label": label,
                               "error": f"{label} failed unexpectedly: {e}"})
    return merge(results, opts.sort), errors


def merge(results, sort):
    """Combine per-site result lists into one ordering.

    - **price-asc / price-desc** — a real shared scale, so sort across
      everything. Listings with no single price (auction ranges, "contact
      seller") sort last in both directions rather than pretending to be free.
    - **newest** — only meaningful where the site gives a date. eBay does not,
      so dated listings lead, ordered, and undated ones follow in site order
      instead of being silently dropped or claimed to be old.
    - **best** — no cross-site meaning at all. Round-robin instead, so the top
      of the page holds each site's own best few rather than one site burying
      the others.
    """
    lists = [items for items in results.values() if items]
    if not lists:
        return []
    if len(lists) == 1:
        return list(lists[0])

    flat = [item for items in lists for item in items]

    if sort in ("price-asc", "price-desc"):
        priced = [i for i in flat if i.price is not None]
        unpriced = [i for i in flat if i.price is None]
        priced.sort(key=lambda i: i.price, reverse=(sort == "price-desc"))
        return priced + unpriced

    if sort == "newest":
        dated = sorted((i for i in flat if i.posted_at),
                       key=lambda i: i.posted_at, reverse=True)
        # Undated ones keep their own site's order, interleaved so no single
        # site owns the whole tail.
        undated = interleave([[i for i in items if not i.posted_at]
                              for items in lists])
        return dated + undated

    return interleave(lists)


def interleave(lists):
    """Round-robin: first of each, second of each, … Keeps every site visible
    near the top when their orderings cannot be compared."""
    out = []
    for row in zip(*(_pad(l, max(len(x) for x in lists)) for l in lists)):
        out.extend(i for i in row if i is not None)
    return out


def _pad(items, size):
    return list(items) + [None] * (size - len(items))
