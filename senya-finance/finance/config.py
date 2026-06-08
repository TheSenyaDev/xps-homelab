import os


class Config:
    # SQLite database (own writable volume).
    DB_PATH = os.environ.get("DB_PATH", "/data/finance.db")
    # Read-only folder of bank exports (the TrueNAS SMB mount).
    IMPORT_DIR = os.environ.get("IMPORT_DIR", "/import")
    # Import on first boot when the DB is empty.
    AUTO_IMPORT = os.environ.get("AUTO_IMPORT", "1") == "1"
