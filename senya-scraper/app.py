"""
WSGI entrypoint.

Everything lives in the `scraper` package; this file exists so `gunicorn app:app`
keeps working and so there is one obvious place to start reading. See
scraper/__init__.py for the architecture.
"""

from scraper import create_app

app = create_app()

if __name__ == "__main__":
    # Dev only — the container runs gunicorn (see Dockerfile).
    app.run(host="0.0.0.0", port=8005, debug=True)
