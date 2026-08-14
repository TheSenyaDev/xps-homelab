"""Shared fixtures for the senya-notes test suite.

VAULT_DIR must point at a throwaway directory *before* `app` is imported: the
module resolves it once at import time (and `send_from_directory` and the path
guard both close over it), so setting it afterwards would test the real vault.
The suite shares one import and each test gets a clean vault instead.
"""
import os
import shutil
import sys
import tempfile

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(TESTS_DIR)
sys.path.insert(0, APP_DIR)

_TMP_DIR = tempfile.mkdtemp(prefix="senya-notes-test-")
os.environ["VAULT_DIR"] = _TMP_DIR

import app as app_module  # noqa: E402  (import must follow the env setup above)

app_module.app.testing = True


@pytest.fixture(autouse=True)
def clean_vault():
    """Every test starts with an empty vault.

    Symlinks are unlinked rather than walked: one test plants a symlink out of
    the vault to prove the guard catches it, and rmtree would both fail on it
    and — if it didn't — delete the directory it points at.
    """
    for name in os.listdir(_TMP_DIR):
        path = os.path.join(_TMP_DIR, name)
        if os.path.islink(path) or os.path.isfile(path):
            os.remove(path)
        else:
            shutil.rmtree(path)
    yield


@pytest.fixture()
def vault():
    """Absolute path of the vault root."""
    return _TMP_DIR


@pytest.fixture()
def client():
    return app_module.app.test_client()


@pytest.fixture()
def write_note():
    """Put a note on disk directly, bypassing the API."""
    def _write(rel, content="# hello\n"):
        path = os.path.join(_TMP_DIR, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path
    return _write


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP_DIR, ignore_errors=True)
