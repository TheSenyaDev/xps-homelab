"""Markdown import (Obsidian → proposed tasks).

Parsing is deliberately forgiving — people paste whole Obsidian notes, not
clean fixtures — but nothing reaches the database from parsing alone. The
parser only ever *proposes* tasks (each carrying warnings about anything it
had to guess); the client reviews and edits them, then posts the confirmed
list back to /api/import/commit. That two-step split is what keeps garbage out.
"""
import re
from datetime import date

from .config import PRIORITIES

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*$")
CHECKBOX_RE = re.compile(r"^(?P<indent>[ \t]*)[-*+]\s+\[(?P<box>.)\]\s*(?P<rest>.*)$")
BULLET_RE = re.compile(r"^(?P<indent>[ \t]*)[-*+]\s+(?P<rest>(?!\[.\]).*\S.*)$")
NUMBERED_RE = re.compile(r"^(?P<indent>[ \t]*)\d+[.)]\s+(?P<rest>.*\S.*)$")
TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z0-9][A-Za-z0-9_/-]*)")
DUE_EMOJI_RE = re.compile(r"[📅📆🗓]️?\s*(\d{4}-\d{2}-\d{2})")
DONE_EMOJI_RE = re.compile(r"✅️?\s*(\d{4}-\d{2}-\d{2})")
# Obsidian Tasks fields we understand well enough to strip but don't store.
# Recurrence is the odd one out: its value is a free-text rule ("every 2 weeks
# when done"), so it runs to the end of the line or to the next field emoji,
# while the others take a single date or token.
FIELD_EMOJI = "📅📆🗓✅🛫⏳⌛➕🔁🆔⛔❌🏁"
RECUR_RE = re.compile(rf"(🔁)️?\s*([^{FIELD_EMOJI}]*)")
DROPPED_EMOJI_RE = re.compile(r"([🛫⏳⌛➕🆔⛔❌🏁])️?\s*(\d{4}-\d{2}-\d{2}|\S+)?")
BACKTICK_STATUS_RE = re.compile(r"`\s*(?:[🔺⏫🔼🔽⏬]️?\s*)?(todo|doing|blocked|done|high|medium|low)\s*`",
                                re.IGNORECASE)
PRIORITY_IN = {"🔺": "high", "⏫": "high", "🔼": "medium", "🔽": "low", "⏬": "low"}
BOX_STATUS = {" ": "todo", "": "todo", "x": "done", "X": "done", "/": "doing",
              ">": "doing", "!": "blocked", "?": "blocked"}
DROPPED_LABEL = {"🛫": "start date", "⏳": "scheduled date", "⌛": "scheduled date",
                 "➕": "created date", "🔁": "recurrence rule", "🆔": "id",
                 "⛔": "dependency", "❌": "cancelled date", "🏁": "on-completion action"}


def parse_markdown(text, default_status="todo"):
    """Obsidian markdown → proposed tasks. Never touches the database."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    # Drop YAML frontmatter, which otherwise looks like headings and list items.
    start = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start = i + 1
                break

    # A lone H1 before any task is the note's title (our own export writes one),
    # not a category — otherwise every round-trip nests everything one deeper.
    headings = [(i, m) for i, l in enumerate(lines[start:], start)
                if (m := HEADING_RE.match(l))]
    h1s = [h for h in headings if len(h[1].group(1)) == 1]
    skip_h1 = (
        len(h1s) == 1
        and headings and headings[0][1] is h1s[0][1]
        and not any(CHECKBOX_RE.match(l) for l in lines[start:h1s[0][0]])
    )

    items = []
    stack = []  # [(heading level, name)] → category path
    for lineno, raw in enumerate(lines[start:], start=start + 1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith(">"):
            continue  # blank lines and callouts/quotes carry no tasks

        if (m := HEADING_RE.match(line)):
            level, name = len(m.group(1)), m.group(2).strip()
            if skip_h1 and level == 1:
                stack = []
                continue
            while stack and stack[-1][0] >= level:
                stack.pop()
            if name:
                stack.append((level, name))
            continue

        checkbox = CHECKBOX_RE.match(line)
        bullet = None if checkbox else (BULLET_RE.match(line) or NUMBERED_RE.match(line))

        if not checkbox and not bullet:
            # An indented, non-list line continues the previous task as notes.
            if items and raw[:1] in (" ", "\t") and line.strip():
                items[-1]["notes"] = (items[-1]["notes"] + "\n" + line.strip()).strip()
            continue

        m = checkbox or bullet
        warnings = []
        if checkbox:
            box = m.group("box")
            status = BOX_STATUS.get(box if box.strip() else " ")
            if status is None:
                status = default_status
                warnings.append(f"unrecognised checkbox “{box}” — treated as {status}")
        else:
            status = default_status
            warnings.append("plain list item, not a checkbox")

        rest = m.group("rest").strip()
        item = parse_task_text(rest, warnings)
        item.update({
            "line": lineno,
            "status": status,
            "category_path": [name for _, name in stack],
            # Plain bullets are the most likely source of junk (prose, nav
            # lists), so they arrive unticked and the reviewer opts them in.
            "include": bool(checkbox) and bool(item["title"]),
        })
        if not item["title"]:
            item["warnings"].append("empty title")
        items.append(item)

    return items


def parse_task_text(text, warnings):
    """Pull tags, priority, dates and notes out of one task line's text."""
    tags, priority, due, completed = [], None, None, None

    if (m := DUE_EMOJI_RE.search(text)):
        due = m.group(1)
        text = text[:m.start()] + text[m.end():]
    if (m := DONE_EMOJI_RE.search(text)):
        completed = m.group(1)
        text = text[:m.start()] + text[m.end():]

    def note_dropped(m):
        label = DROPPED_LABEL.get(m.group(1), "field")
        value = (m.group(2) or "").strip()
        warnings.append(f"dropped {label} “{value}”" if value else f"dropped {label}")
        return " "

    text = RECUR_RE.sub(note_dropped, text)
    text = DROPPED_EMOJI_RE.sub(note_dropped, text)

    for emoji, level in PRIORITY_IN.items():
        if emoji in text:
            priority = priority or level
            text = text.replace(emoji, "")

    # our own export writes `doing` / `blocked`; older files wrote `🔺 high`
    for m in list(BACKTICK_STATUS_RE.finditer(text)):
        word = m.group(1).lower()
        if word in PRIORITIES:
            priority = priority or word
    text = BACKTICK_STATUS_RE.sub("", text)

    for m in TAG_RE.finditer(text):
        tags.append(m.group(1).lower())
    text = TAG_RE.sub(" ", text)

    title = re.sub(r"\s{2,}", " ", text.replace("️", "")).strip(" -–—\t")

    if due:
        try:
            date.fromisoformat(due)
        except ValueError:
            warnings.append(f"invalid due date “{due}” — dropped")
            due = None

    return {
        "title": title[:500],
        "notes": "",
        "priority": priority or "medium",
        "due_date": due,
        "completed_at": completed,
        "tags": sorted(dict.fromkeys(tags)),
        "warnings": warnings,
    }


def resolve_category_path(db, path, created):
    """Find (or create) the category chain for ['Work', 'Garage']; None = root."""
    parent = None
    for name in path:
        name = name.strip()
        if not name:
            continue
        row = db.execute(
            "SELECT id FROM categories WHERE name = ? AND parent_id IS ?", (name, parent)
        ).fetchone()
        if row:
            parent = row["id"]
            continue
        nxt = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories").fetchone()[0]
        cur = db.execute(
            "INSERT INTO categories (name, parent_id, position) VALUES (?, ?, ?)",
            (name, parent, nxt),
        )
        parent = cur.lastrowid
        created.append(name)
    return parent


def lookup_category_path(db, path):
    """Resolve a category chain without creating anything; None if incomplete."""
    parent = None
    for name in path:
        row = db.execute(
            "SELECT id FROM categories WHERE name = ? AND parent_id IS ?",
            (name.strip(), parent),
        ).fetchone()
        if row is None:
            return None
        parent = row["id"]
    return parent
