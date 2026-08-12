"""The app's own DB (created at import time by conftest) is the main proof
that BASELINE + MIGRATIONS produces a working schema — every other test file
exercises it indirectly through the API. These check the migration runner
itself: it reaches the declared version and is safe to re-run.
"""
import sqlite3

import pytest

import app as app_module


def test_fresh_database_reaches_schema_version(db):
    version = db.execute("PRAGMA user_version").fetchone()[0]
    assert version == app_module.SCHEMA_VERSION


def test_migrate_is_a_no_op_once_up_to_date(db):
    before = db.execute("PRAGMA user_version").fetchone()[0]
    result = app_module.migrate(db)
    after = db.execute("PRAGMA user_version").fetchone()[0]
    assert result == before == after == app_module.SCHEMA_VERSION


def test_expected_tables_exist(db):
    tables = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")}
    for expected in ("tasks", "categories", "tags", "task_tags", "settings",
                      "caldav_map", "caldav_state", "caldav_tombstones",
                      "caldav_collections"):
        assert expected in tables


def test_status_check_constraint_rejects_bad_values(db):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO tasks (title, status) VALUES ('x', 'not-a-status')")
