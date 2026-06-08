"""Import orchestrator: scan the import dir, parse each recognized file, dedupe, and
insert new transactions (auto-categorized). Idempotent — re-running only adds
genuinely new rows and never touches existing (possibly hand-categorized) ones.
"""
import hashlib
import os

from ..categorize import categorize, income_category_id, load_rules
from .parsers import SOURCES, detect


def _csv_files(root):
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if fn.lower().endswith(".csv"):
                yield os.path.join(dirpath, fn)


def _dedupe_hash(account, tx, occurrence):
    base = f"{account}|{tx['date']}|{tx['merchant']}|{tx['amount']:.2f}|{tx['direction']}|{occurrence}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def run_import(db, import_dir):
    if not os.path.isdir(import_dir):
        return {"error": f"import dir not found: {import_dir}", "files": 0, "inserted": 0, "skipped": 0}

    rules = load_rules(db)
    income_id = income_category_id(db)
    # Occurrence counter per identical (account,date,merchant,amount,direction) so two
    # legitimately-identical same-day charges both survive, while re-imports dedupe.
    seen = {}
    files = inserted = skipped = unmatched = 0

    for path in sorted(_csv_files(import_dir)):
        source = detect(path)
        if source is None:
            unmatched += 1
            continue
        files += 1
        for tx in source.parse(path):
            key = (source.account, tx["date"], tx["merchant"], round(tx["amount"], 2), tx["direction"])
            occ = seen.get(key, 0)
            seen[key] = occ + 1
            h = _dedupe_hash(source.account, tx, occ)
            cat = categorize(rules, tx["merchant"], tx["direction"], income_id)
            cur = db.execute(
                "INSERT OR IGNORE INTO transactions "
                "(hash, date, month, merchant, amount, direction, account, bank, category_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (h, tx["date"], tx["date"][:7], tx["merchant"], tx["amount"],
                 tx["direction"], source.account, source.bank, cat),
            )
            if cur.rowcount:
                inserted += 1
            else:
                skipped += 1
    db.commit()
    return {
        "files": files,
        "inserted": inserted,
        "skipped": skipped,
        "unmatched_files": unmatched,
        "sources": [s.name for s in SOURCES],
    }
