"""Running a saved search and reporting what changed.

This diff is the whole point of the app, and every rule in it exists because
getting it wrong produces a specific, annoying failure: re-announcing the same
listing as new, missing a price drop, or declaring everything sold because a
site throttled us. Each of those has a test here.
"""


def test_first_run_reports_everything_as_new(client, saved_search, stub_scrape, listing):
    s = saved_search()
    stub_scrape([listing("a", price=10), listing("b", price=20)])

    body = client.post(f"/api/searches/{s['id']}/run").get_json()
    assert len(body["new"]) == 2
    assert body["price_drops"] == []


def test_second_run_reports_nothing_new(client, saved_search, stub_scrape, listing):
    """The same listing must never be announced twice."""
    s = saved_search()
    items = [listing("a", price=10)]
    stub_scrape(items)
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape(items)
    body = client.post(f"/api/searches/{s['id']}/run").get_json()
    assert body["new"] == []


def test_a_genuinely_new_listing_is_reported_on_a_later_run(
        client, saved_search, stub_scrape, listing):
    s = saved_search()
    stub_scrape([listing("a", price=10)])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("a", price=10), listing("b", price=20)])
    body = client.post(f"/api/searches/{s['id']}/run").get_json()
    assert [i["uid"] for i in body["new"]] == ["ebay-ca:b"]


# ---- price drops -----------------------------------------------------------

def test_a_price_drop_is_reported_with_the_old_price(
        client, saved_search, stub_scrape, listing):
    s = saved_search()
    stub_scrape([listing("a", price=100)])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("a", price=80)])
    drops = client.post(f"/api/searches/{s['id']}/run").get_json()["price_drops"]
    assert len(drops) == 1
    assert drops[0]["was"] == 100
    assert drops[0]["price"] == 80


def test_a_price_rise_is_not_a_drop(client, saved_search, stub_scrape, listing):
    s = saved_search()
    stub_scrape([listing("a", price=80)])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("a", price=100)])
    assert client.post(f"/api/searches/{s['id']}/run").get_json()["price_drops"] == []


def test_an_unchanged_price_is_not_a_drop(client, saved_search, stub_scrape, listing):
    s = saved_search()
    stub_scrape([listing("a", price=80)])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("a", price=80)])
    assert client.post(f"/api/searches/{s['id']}/run").get_json()["price_drops"] == []


def test_each_step_of_a_slow_slide_is_reported(client, saved_search, stub_scrape, listing):
    """Compared against the last recorded price, not the first, so a drip-down
    over several runs is reported every time it actually moves."""
    s = saved_search()
    for price in (100, 90, 80):
        stub_scrape([listing("a", price=price)])
        body = client.post(f"/api/searches/{s['id']}/run").get_json()
    assert body["price_drops"][0]["was"] == 90


def test_a_listing_that_loses_its_price_is_not_a_drop(
        client, saved_search, stub_scrape, listing):
    """Going from a number to "contact seller" is not a discount."""
    s = saved_search()
    stub_scrape([listing("a", price=100)])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("a", price=None)])
    assert client.post(f"/api/searches/{s['id']}/run").get_json()["price_drops"] == []


# ---- listings that leave ---------------------------------------------------

def test_a_vanished_listing_is_flagged_gone_not_deleted(
        client, saved_search, stub_scrape, listing, db):
    s = saved_search()
    stub_scrape([listing("a"), listing("b")])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("a")])
    client.post(f"/api/searches/{s['id']}/run")

    rows = {r["uid"]: r["gone"] for r in
            db.execute("SELECT uid, gone FROM listings WHERE search_id=?", (s["id"],))}
    assert rows == {"ebay-ca:a": 0, "ebay-ca:b": 1}


def test_a_returning_listing_is_not_announced_as_new_again(
        client, saved_search, stub_scrape, listing):
    """History is kept precisely so a relisted item doesn't read as new."""
    s = saved_search()
    stub_scrape([listing("a")])
    client.post(f"/api/searches/{s['id']}/run")
    stub_scrape([])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("a")])
    body = client.post(f"/api/searches/{s['id']}/run").get_json()
    assert body["new"] == []


# ---- partial failure -------------------------------------------------------
#
# Marketplaces throttle independently. Treating "we couldn't ask" as "it's gone"
# would mark a whole site's history dead and then re-announce all of it as new
# on the next successful run — the single worst failure this app can have.

def test_a_failed_site_does_not_mark_its_listings_gone(
        client, saved_search, stub_scrape, listing, db):
    s = saved_search(sites=["ebay-ca", "facebook"])
    stub_scrape([listing("e1", site="ebay-ca"), listing("f1", site="facebook")])
    client.post(f"/api/searches/{s['id']}/run")

    # Facebook errors; eBay answers without the Facebook listing.
    stub_scrape([listing("e1", site="ebay-ca")],
                errors=[{"site": "facebook", "error": "throttled"}])
    client.post(f"/api/searches/{s['id']}/run")

    gone = {r["uid"]: r["gone"] for r in
            db.execute("SELECT uid, gone FROM listings WHERE search_id=?", (s["id"],))}
    assert gone["facebook:f1"] == 0, "a throttled site's listings must not be marked gone"


def test_a_listing_missing_from_a_site_that_answered_is_still_marked_gone(
        client, saved_search, stub_scrape, listing, db):
    """The exemption is per site — the site that did answer is still diffed."""
    s = saved_search(sites=["ebay-ca", "facebook"])
    stub_scrape([listing("e1", site="ebay-ca"), listing("e2", site="ebay-ca"),
                 listing("f1", site="facebook")])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([listing("e1", site="ebay-ca")],
                errors=[{"site": "facebook", "error": "throttled"}])
    client.post(f"/api/searches/{s['id']}/run")

    gone = {r["uid"]: r["gone"] for r in
            db.execute("SELECT uid, gone FROM listings WHERE search_id=?", (s["id"],))}
    assert gone["ebay-ca:e2"] == 1
    assert gone["facebook:f1"] == 0


def test_every_site_failing_is_a_502_and_changes_nothing(
        client, saved_search, stub_scrape, listing, db):
    s = saved_search()
    stub_scrape([listing("a")])
    client.post(f"/api/searches/{s['id']}/run")

    stub_scrape([], errors=[{"site": "ebay-ca", "error": "blocked"}])
    resp = client.post(f"/api/searches/{s['id']}/run")
    assert resp.status_code == 502

    gone = db.execute("SELECT gone FROM listings WHERE search_id=?", (s["id"],)).fetchone()
    assert gone["gone"] == 0, "a total failure must not wipe the history"


# ---- not found -------------------------------------------------------------

def test_running_a_search_that_does_not_exist(client):
    assert client.post("/api/searches/9999/run").status_code == 404
