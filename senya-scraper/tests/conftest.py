"""Shared fixtures for the senya-scraper test suite.

The app has a real factory (`create_app`), so each test session gets its own
app on a throwaway database rather than the import-time singleton the other
senya apps use.

Nothing here touches the network. Site adapters are real objects — they
register themselves on import — but every test that needs results stubs the
scrape, because a suite whose outcome depends on eBay being reachable is a
suite that fails for reasons that aren't about this code.
"""
import os
import shutil
import sys
import tempfile

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(TESTS_DIR)
sys.path.insert(0, APP_DIR)

_TMP_DIR = tempfile.mkdtemp(prefix="senya-scraper-test-")

from scraper import create_app  # noqa: E402
from scraper.db import connect  # noqa: E402
from scraper.sites.base import Listing  # noqa: E402

DB_PATH = os.path.join(_TMP_DIR, "scraper.db")

TABLES = ("listings", "searches")


@pytest.fixture(scope="session")
def app():
    return create_app({"DB_PATH": DB_PATH, "TESTING": True})


@pytest.fixture(autouse=True)
def clean_db(app):
    """Every test starts on an empty but already-migrated schema."""
    conn = connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = OFF")
    for table in TABLES:
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    conn.close()
    yield


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def db(app):
    """A raw connection for assertions the API doesn't expose."""
    conn = connect(DB_PATH)
    yield conn
    conn.close()


@pytest.fixture()
def listing():
    """Build a Listing without repeating every field at each call site."""
    def _make(uid, title="A thing", price=10.0, site="ebay-ca", **kw):
        return Listing(uid=f"{site}:{uid}", site=site, title=title,
                       url=f"https://example.test/{uid}", price=price, **kw)
    return _make


@pytest.fixture()
def saved_search(client):
    """A saved search to run diffs against."""
    def _make(name="Test search", query="thing", **kw):
        return client.post("/api/searches",
                           json={"name": name, "query": query, **kw}).get_json()
    return _make


@pytest.fixture()
def stub_scrape(monkeypatch):
    """Replace the live scrape with a fixed result set.

    Patches `aggregate.search_many` where the searches blueprint looks it up, so
    the diff logic is exercised against known input with no network involved.
    """
    from scraper.api import searches as searches_mod

    def _stub(items, errors=None):
        def fake(keys, opts, params_by_site=None, timeout=120, criteria_by_site=None):
            return list(items), list(errors or [])
        monkeypatch.setattr(searches_mod.aggregate, "search_many", fake)
    return _stub


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP_DIR, ignore_errors=True)
