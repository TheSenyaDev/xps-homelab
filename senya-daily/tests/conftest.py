"""Shared fixtures for the senya-daily test suite.

DB_PATH and NOTES_DIR must point at throwaway locations *before* `app` is
imported: both are resolved at module scope, and NOTES_DIR is derived from
DB_PATH, so setting them afterwards would write into the real volume. The suite
shares one import and each test wipes the tables instead.
"""
import os
import shutil
import sqlite3
import sys
import tempfile

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(TESTS_DIR)
sys.path.insert(0, APP_DIR)

_TMP_DIR = tempfile.mkdtemp(prefix="senya-daily-test-")
os.environ["DB_PATH"] = os.path.join(_TMP_DIR, "daily.db")
os.environ["NOTES_DIR"] = os.path.join(_TMP_DIR, "notes")

import app as app_module  # noqa: E402  (import must follow the env setup above)

app_module.app.testing = True
app_module.init_db()

TABLES = ("entries", "notes", "trackers")


@pytest.fixture(autouse=True)
def clean_db():
    """Every test starts on an empty schema with no markdown on disk.

    The default trackers are *not* re-seeded: tests that want them call
    `seeded_trackers`, and the rest get a blank slate so an assertion about
    "the trackers" can't accidentally be about the seed data.
    """
    conn = sqlite3.connect(os.environ["DB_PATH"])
    conn.execute("PRAGMA foreign_keys = OFF")
    for table in TABLES:
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    conn.close()
    shutil.rmtree(os.environ["NOTES_DIR"], ignore_errors=True)
    yield


@pytest.fixture()
def client():
    return app_module.app.test_client()


@pytest.fixture()
def db():
    """A raw connection for assertions the API doesn't expose."""
    conn = app_module.connect()
    yield conn
    conn.close()


@pytest.fixture()
def notes_dir():
    return os.environ["NOTES_DIR"]


@pytest.fixture()
def make_tracker(client):
    """Create a tracker through the API and hand back its dict."""
    def _make(name="Pushups", **kw):
        return client.post("/api/trackers", json={"name": name, **kw}).get_json()
    return _make


@pytest.fixture()
def seeded_trackers(client):
    """The five default trackers, one of each supported type."""
    return [client.post("/api/trackers",
                        json={"name": n, "type": t, "unit": u, "icon": i}).get_json()
            for n, t, u, i in [("Pushups", "number", "reps", "💪"),
                               ("Food", "text", "", "🍔"),
                               ("Workout", "check", "", "🏋️"),
                               ("Mood", "rating", "", "🙂")]]


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP_DIR, ignore_errors=True)
