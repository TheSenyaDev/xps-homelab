"""Entry point. See tasks/__init__.py for the app factory and module layout.

Kept as a thin composition root (rather than folding into tasks/__init__.py)
so `gunicorn app:app` and the test suite's `import app` keep working unchanged.
"""
import os

from tasks import create_app
from tasks.db import SCHEMA_VERSION, connect, migrate  # re-exported for tests
from tasks.markdown_export import build_markdown  # re-exported for tests

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

app = create_app(STATIC_DIR)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
