"""Runtime config and shared vocabularies.

Read from the environment at import time (tests set DB_PATH / MARKDOWN_PATH
before importing anything else in this package — see tests/conftest.py).
"""
import os

DB_PATH = os.environ.get("DB_PATH", "/data/tasks.db")
MARKDOWN_PATH = os.environ.get("MARKDOWN_PATH", "/data/Tasks.md")

# Vocabularies. Adding a value here is most of what it takes for the API and the
# /api/meta-driven UI pickers to accept it (the CHECK constraints live in a
# migration, so widening those needs a new one) — order is display/sort order.
STATUSES = ("todo", "doing", "blocked", "done")
PRIORITIES = ("high", "medium", "low")
