"""Saved-search CRUD, the blocklist, and the schema."""
from scraper.api.searches import apply_blocklist, parse_blocklist, parse_names
from scraper.db import MIGRATIONS, migrate


# ---- CRUD ------------------------------------------------------------------

def test_create_and_list(client):
    created = client.post("/api/searches", json={"name": "Bikes", "query": "bike"}).get_json()
    assert created["name"] == "Bikes"

    listed = client.get("/api/searches").get_json()
    assert [s["name"] for s in listed] == ["Bikes"]


def test_create_requires_a_query(client):
    assert client.post("/api/searches", json={"name": "No query"}).status_code == 400


def test_update_a_search(client, saved_search):
    s = saved_search()
    updated = client.patch(f"/api/searches/{s['id']}",
                           json={"name": "Renamed", "query": "other"}).get_json()
    assert updated["name"] == "Renamed"
    assert updated["query"] == "other"


def test_delete_a_search(client, saved_search):
    s = saved_search()
    assert client.delete(f"/api/searches/{s['id']}").status_code in (200, 204)
    assert client.get(f"/api/searches/{s['id']}").status_code == 404


def test_deleting_a_search_takes_its_listings_with_it(
        client, saved_search, stub_scrape, listing, db):
    s = saved_search()
    stub_scrape([listing("a")])
    client.post(f"/api/searches/{s['id']}/run")
    assert db.execute("SELECT COUNT(*) FROM listings").fetchone()[0] == 1

    client.delete(f"/api/searches/{s['id']}")
    assert db.execute("SELECT COUNT(*) FROM listings").fetchone()[0] == 0


def test_get_a_search_that_does_not_exist(client):
    assert client.get("/api/searches/9999").status_code == 404


# ---- results ---------------------------------------------------------------

def test_results_are_returned_after_a_run(client, saved_search, stub_scrape, listing):
    s = saved_search()
    stub_scrape([listing("a", title="A bike"), listing("b", title="Another")])
    client.post(f"/api/searches/{s['id']}/run")

    rows = client.get(f"/api/searches/{s['id']}/results").get_json()
    assert {r["title"] for r in rows} == {"A bike", "Another"}


def test_results_hide_departed_listings_unless_asked(
        client, saved_search, stub_scrape, listing):
    """Gone listings stay in the database for the diff, but shouldn't read as live."""
    s = saved_search()
    stub_scrape([listing("a"), listing("b")])
    client.post(f"/api/searches/{s['id']}/run")
    stub_scrape([listing("a")])
    client.post(f"/api/searches/{s['id']}/run")

    live = client.get(f"/api/searches/{s['id']}/results").get_json()
    assert [r["uid"] for r in live] == ["ebay-ca:a"]

    everything = client.get(f"/api/searches/{s['id']}/results?include_gone=1").get_json()
    assert len(everything) == 2


# ---- blocklist parsing -----------------------------------------------------

def test_parse_names_accepts_commas_and_newlines():
    assert parse_names("alice, bob\ncarol") == ["alice", "bob", "carol"]


def test_parse_names_strips_at_signs_and_blanks():
    assert parse_names(" @alice , , bob ") == ["alice", "bob"]


def test_parse_names_deduplicates_case_insensitively():
    assert parse_names("Alice, alice, ALICE") == ["Alice"]


def test_parse_names_of_none_is_none():
    """None means "not supplied" — distinct from an empty list, which clears it."""
    assert parse_names(None) is None
    assert parse_names("") == []


def test_parse_blocklist_from_per_site_map():
    assert parse_blocklist({"ebay-ca": "alice, bob"}) == {"ebay-ca": ["alice", "bob"]}


def test_a_bare_list_attaches_to_the_only_site_in_scope():
    assert parse_blocklist("alice", sites_in_scope=["ebay-ca"]) == {"ebay-ca": ["alice"]}


def test_a_bare_list_is_dropped_when_the_site_is_ambiguous():
    """With two markets in scope there's no way to know whose seller this is."""
    assert parse_blocklist("alice", sites_in_scope=["ebay-ca", "facebook"]) == {}


# ---- blocklist application -------------------------------------------------

def test_apply_blocklist_splits_kept_from_hidden(listing):
    items = [listing("a", seller_name="alice"), listing("b", seller_name="bob")]
    kept, hidden = apply_blocklist(items, {"ebay-ca": {"alice"}})
    assert [i.uid for i in kept] == ["ebay-ca:b"]
    assert [i.uid for i in hidden] == ["ebay-ca:a"]


def test_a_blocklist_only_applies_to_its_own_site(listing):
    items = [listing("a", seller_name="alice", site="ebay-ca"),
             listing("b", seller_name="alice", site="facebook")]
    kept, hidden = apply_blocklist(items, {"ebay-ca": {"alice"}})
    assert [i.uid for i in kept] == ["facebook:b"]


def test_blocklist_matching_is_case_insensitive(listing):
    kept, hidden = apply_blocklist([listing("a", seller_name="Alice")], {"ebay-ca": {"alice"}})
    assert kept == [] and len(hidden) == 1


def test_no_blocklist_keeps_everything(listing):
    items = [listing("a", seller_name="alice")]
    kept, hidden = apply_blocklist(items, None)
    assert kept == items and hidden == []


def test_blocked_sellers_never_enter_the_history(
        client, saved_search, stub_scrape, listing, db):
    """Stored blocked listings would be announced as new the moment you unblock."""
    s = saved_search(blocked_sellers={"ebay-ca": "alice"})
    stub_scrape([listing("a", seller_name="alice"), listing("b", seller_name="bob")])
    client.post(f"/api/searches/{s['id']}/run")

    stored = [r["uid"] for r in db.execute("SELECT uid FROM listings")]
    assert stored == ["ebay-ca:b"]


# ---- schema ----------------------------------------------------------------

def test_migrations_reach_the_declared_version(db):
    assert db.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)


def test_migrate_is_a_no_op_once_up_to_date(db):
    before = db.execute("PRAGMA user_version").fetchone()[0]
    migrate(db)
    assert db.execute("PRAGMA user_version").fetchone()[0] == before


def test_expected_tables_exist(db):
    tables = {r["name"] for r in
              db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"searches", "listings"} <= tables
