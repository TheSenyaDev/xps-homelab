"""Rule-based categorization. Pure functions over a rules snapshot so callers
load the rules once and reuse them across many transactions."""
import re


def load_rules(db):
    return db.execute(
        "SELECT pattern, is_regex, category_id FROM rules ORDER BY priority, id"
    ).fetchall()


def income_category_id(db):
    row = db.execute("SELECT id FROM categories WHERE kind = 'income' ORDER BY id LIMIT 1").fetchone()
    return row["id"] if row else None


def match_category(rules, merchant):
    """First matching rule's category_id, or None."""
    upper = merchant.upper()
    for r in rules:
        pat = r["pattern"]
        try:
            if r["is_regex"]:
                if re.search(pat, merchant, re.IGNORECASE):
                    return r["category_id"]
            elif pat.upper() in upper:
                return r["category_id"]
        except re.error:
            continue  # a bad user regex shouldn't break categorization
    return None


def categorize(rules, merchant, direction, income_id):
    """Rule match wins; otherwise money coming in defaults to Income, money going
    out stays uncategorized (so the user is prompted to label real spending)."""
    cid = match_category(rules, merchant)
    if cid is not None:
        return cid
    if direction == "in":
        return income_id
    return None
