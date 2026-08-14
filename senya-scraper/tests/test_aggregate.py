"""Merging results from several marketplaces.

The merge is the part with real judgement in it: the sites share no ranking, so
each sort has to mean something specific or the combined list is arbitrary.
"""
import pytest

from scraper import aggregate
from scraper.aggregate import interleave, merge
from scraper.sites.base import Listing


def L(uid, price=None, posted_at="", site="ebay-ca"):
    return Listing(uid=uid, site=site, title=uid, url=f"http://x/{uid}",
                   price=price, posted_at=posted_at)


# ---- price sorts -----------------------------------------------------------

def test_price_asc_sorts_across_every_site():
    merged = merge({"a": [L("a1", 30), L("a2", 10)],
                    "b": [L("b1", 20), L("b2", 5)]}, "price-asc")
    assert [i.price for i in merged] == [5, 10, 20, 30]


def test_price_desc_sorts_across_every_site():
    merged = merge({"a": [L("a1", 30), L("a2", 10)],
                    "b": [L("b1", 20)]}, "price-desc")
    assert [i.price for i in merged] == [30, 20, 10]


def test_unpriced_listings_sort_last_in_both_directions():
    """An auction range has no single price; treating None as 0 would put it
    first on price-asc and misreport it as the cheapest thing on the page."""
    results = {"a": [L("cheap", 5), L("range", None)], "b": [L("dear", 50)]}

    asc = merge(results, "price-asc")
    assert [i.uid for i in asc] == ["cheap", "dear", "range"]

    desc = merge(results, "price-desc")
    assert [i.uid for i in desc] == ["dear", "cheap", "range"]


# ---- newest ----------------------------------------------------------------

def test_newest_puts_dated_listings_first_in_order():
    merged = merge({"a": [L("old", posted_at="2026-01-01"),
                          L("new", posted_at="2026-05-01")],
                    "b": [L("mid", posted_at="2026-03-01")]}, "newest")
    assert [i.uid for i in merged[:3]] == ["new", "mid", "old"]


def test_newest_keeps_undated_listings_rather_than_dropping_them():
    """eBay dates nothing. Dropping those would empty the results for a sort the
    UI still offers, and claiming a date would be a lie."""
    merged = merge({"a": [L("dated", posted_at="2026-05-01")],
                    "b": [L("undated1"), L("undated2")]}, "newest")
    assert [i.uid for i in merged] == ["dated", "undated1", "undated2"]
    assert len(merged) == 3


# ---- best ------------------------------------------------------------------

def test_best_round_robins_so_no_site_buries_the_other():
    merged = merge({"a": [L("a1"), L("a2"), L("a3")],
                    "b": [L("b1"), L("b2")]}, "best")
    assert [i.uid for i in merged] == ["a1", "b1", "a2", "b2", "a3"]


def test_best_keeps_every_listing_when_lists_are_uneven():
    merged = merge({"a": [L("a1")], "b": [L("b1"), L("b2"), L("b3")]}, "best")
    assert sorted(i.uid for i in merged) == ["a1", "b1", "b2", "b3"]


# ---- degenerate cases ------------------------------------------------------

def test_a_single_site_is_passed_through_untouched():
    """One site's own order is already meaningful — don't reshuffle it."""
    items = [L("x1"), L("x2"), L("x3")]
    assert merge({"a": items}, "best") == items


def test_empty_and_all_empty_results():
    assert merge({}, "best") == []
    assert merge({"a": [], "b": []}, "best") == []


def test_sites_that_returned_nothing_are_ignored_not_padded():
    merged = merge({"a": [L("a1"), L("a2")], "b": []}, "best")
    assert [i.uid for i in merged] == ["a1", "a2"]


def test_interleave_directly():
    assert interleave([[1, 2, 3], [4, 5]]) == [1, 4, 2, 5, 3]
    assert interleave([[1], [2], [3]]) == [1, 2, 3]


# ---- resolving which sites to search ---------------------------------------

def test_resolve_a_single_key():
    key = aggregate.site_registry.keys()[0]
    assert aggregate.resolve(key) == [key]


def test_resolve_all_expands_to_every_site():
    assert set(aggregate.resolve(aggregate.ALL)) == set(aggregate.site_registry.keys())


def test_resolve_deduplicates():
    key = aggregate.site_registry.keys()[0]
    assert aggregate.resolve([key, key]) == [key]


def test_resolve_rejects_an_unknown_site():
    """Silently dropping it would report "nothing for sale" for a site that was
    never actually searched."""
    from scraper.sites.base import UnknownSite
    with pytest.raises(UnknownSite):
        aggregate.resolve(["not_a_marketplace"])


def test_resolve_of_nothing_falls_back_to_the_first_site():
    assert aggregate.resolve(None) == [aggregate.site_registry.keys()[0]]
