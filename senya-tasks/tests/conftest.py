"""Shared fixtures for the senya-tasks test suite.

DB_PATH / MARKDOWN_PATH must point at a throwaway location *before* `app` is
imported: app.py runs its own migrations and starts the CalDAV worker thread
as a side effect of import (it has to — gunicorn imports the module rather
than running it as __main__, so that's the only hook available). Importing
it again per test would re-register Flask routes and spawn a second worker
thread, so the whole suite shares one import and each test just wipes the
tables clean instead.
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

_TMP_DIR = tempfile.mkdtemp(prefix="senya-tasks-test-")
os.environ["DB_PATH"] = os.path.join(_TMP_DIR, "tasks.db")
os.environ["MARKDOWN_PATH"] = os.path.join(_TMP_DIR, "Tasks.md")
os.environ.setdefault("CALDAV_ENABLED", "false")

import app as app_module  # noqa: E402  (import must follow the env setup above)
import caldav  # noqa: E402

app_module.app.testing = True

# Every table the schema creates, in an order that keeps FK checks quiet with
# them switched off — cheaper than working out a deletion order by hand.
TABLES = ("task_tags", "tags", "tasks", "categories", "settings",
          "caldav_map", "caldav_state", "caldav_tombstones", "caldav_collections")


@pytest.fixture(autouse=True)
def clean_db():
    """Every test starts on an empty but already-migrated schema."""
    conn = sqlite3.connect(os.environ["DB_PATH"])
    conn.execute("PRAGMA foreign_keys = OFF")
    for table in TABLES:
        conn.execute(f"DELETE FROM {table}")
    conn.commit()
    conn.close()
    yield


@pytest.fixture()
def client():
    return app_module.app.test_client()


@pytest.fixture()
def db():
    """A raw connection for assertions the API doesn't expose (triggers, etc.)."""
    conn = app_module.connect()
    yield conn
    conn.close()


@pytest.fixture()
def caldav_config():
    """Snapshot caldav.CONFIG and restore it, for tests that flip a mode/flag."""
    before = dict(caldav.CONFIG)
    yield caldav.CONFIG
    caldav.CONFIG.clear()
    caldav.CONFIG.update(before)


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP_DIR, ignore_errors=True)
