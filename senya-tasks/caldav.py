"""Two-way CalDAV sync: senya-tasks tasks ⇄ VTODOs in a calendar collection.

Point it at the same collection your phone's account uses and tasks show up in
Apple Reminders (Reminders reads VTODO; the Calendar app reads VEVENT, which is
why tasks appear there and not in your calendar grid).

How it stays consistent
-----------------------
Both sides can change, so every synced task carries a bookmark in `caldav_map`:
the local `updated_at` and the remote `LAST-MODIFIED` **as of the last time the
two agreed**. A side is "dirty" when its current revision differs from its
bookmark. That makes the four cases explicit rather than guessed:

    neither dirty   nothing to do
    local only      PUT (guarded by If-Match, so we lose the race rather than
                    clobber a change that landed between poll and push)
    remote only     write the VTODO into SQLite
    both            conflict → newest timestamp wins, and the loser is logged

Deletes are the classic hole in naive syncs, and they get explicit handling in
both directions: a local delete leaves a row in `caldav_tombstones` (written by
a trigger, so it survives the row disappearing) which becomes a remote DELETE;
a remote delete arrives as a 404 in the sync-collection report and removes the
local task.

Change detection uses WebDAV-Sync (RFC 6578) when the server offers a
sync-token — both Baikal and Nextcloud do, being sabre/dav — so a poll costs one
request when nothing changed, instead of listing the whole collection.
"""

import datetime
import logging
import os
import re
import threading
import time
import uuid
import xml.etree.ElementTree as ET

import requests
from requests.auth import HTTPBasicAuth, HTTPDigestAuth

log = logging.getLogger("senya-tasks.caldav")

# ---- configuration (env) --------------------------------------------------

def _env_bool(name, default=False):
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


CONFIG = {
    "enabled": _env_bool("CALDAV_ENABLED", False),
    # Full URL of the calendar collection, e.g.
    #   http://192.168.2.100:5232/dav.php/calendars/Senya/default/
    "url": os.environ.get("CALDAV_URL", "").strip(),
    "user": os.environ.get("CALDAV_USER", "").strip(),
    "password": os.environ.get("CALDAV_PASSWORD", ""),
    # Baikal defaults to digest; Nextcloud is basic. "auto" probes once.
    "auth": os.environ.get("CALDAV_AUTH", "auto").strip().lower(),
    "interval": int(os.environ.get("CALDAV_INTERVAL", "120")),
    "timeout": int(os.environ.get("CALDAV_TIMEOUT", "20")),
}

# Settings saved from the UI live in caldav_state and win over the environment,
# so the env vars act as the initial default and the app stays configurable
# without editing .env and redeploying.
CONFIG_KEYS = ("url", "user", "password", "auth", "interval", "enabled")


def load_config(conn):
    """Overlay saved settings onto the env defaults. Safe to call repeatedly."""
    for key in CONFIG_KEYS:
        saved = state_get(conn, "cfg_" + key)
        if saved is None:
            continue
        if key == "enabled":
            CONFIG[key] = saved == "true"
        elif key == "interval":
            CONFIG[key] = max(30, int(saved or 120))
        else:
            CONFIG[key] = saved
    return CONFIG


def save_config(conn, values):
    """Persist settings from the UI. Validates before writing anything."""
    url = (values.get("url") or "").strip()
    if url and not re.match(r"^https?://", url):
        raise ValueError("url must start with http:// or https://")
    if url and not url.endswith("/"):
        url += "/"                       # a collection URL, not an object
    user = (values.get("user") or "").strip()
    auth = (values.get("auth") or "auto").strip().lower()
    if auth not in ("auto", "basic", "digest"):
        raise ValueError("auth must be auto, basic or digest")
    try:
        interval = max(30, int(values.get("interval") or 120))
    except (TypeError, ValueError):
        raise ValueError("interval must be a number of seconds")
    enabled = bool(values.get("enabled"))
    if enabled and not (url and user):
        raise ValueError("a url and user are required before sync can be enabled")

    state_set(conn, "cfg_url", url)
    state_set(conn, "cfg_user", user)
    state_set(conn, "cfg_auth", auth)
    state_set(conn, "cfg_interval", str(interval))
    state_set(conn, "cfg_enabled", "true" if enabled else "false")
    # Blank means "leave the stored password alone" — the UI never receives the
    # current one, so an empty field must not wipe it.
    if values.get("password"):
        state_set(conn, "cfg_password", values["password"])
        state_set(conn, "auth_scheme", "")     # re-probe with the new credential
    conn.commit()
    return load_config(conn)


NS = {
    "d": "DAV:",
    "c": "urn:ietf:params:xml:ns:caldav",
}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)

# ---- iCalendar text -------------------------------------------------------

PRIORITY_TO_ICAL = {"high": 1, "medium": 5, "low": 9}
STATUS_TO_ICAL = {"todo": "NEEDS-ACTION", "doing": "IN-PROCESS",
                  "blocked": "NEEDS-ACTION", "done": "COMPLETED"}
ICAL_TO_STATUS = {"NEEDS-ACTION": "todo", "IN-PROCESS": "doing",
                  "COMPLETED": "done", "CANCELLED": "done"}


def ical_escape(text):
    return (str(text).replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\n", "\\n"))


def ical_unescape(text):
    out, i = [], 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            out.append({"n": "\n", "N": "\n"}.get(nxt, nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def fold(line):
    """RFC 5545 line folding — 75 octets, continuations start with a space."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    chunks, start = [], 0
    while start < len(raw):
        end = min(start + (75 if not chunks else 74), len(raw))
        # don't split a multi-byte character
        while end > start and end < len(raw) and (raw[end] & 0xC0) == 0x80:
            end -= 1
        chunks.append(raw[start:end].decode("utf-8"))
        start = end
    return "\r\n ".join(chunks)


def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text.replace("\r\n", "\n"))


def utc_stamp(value=None):
    dt = value or datetime.datetime.now(datetime.timezone.utc)
    return dt.strftime("%Y%m%dT%H%M%SZ")


def sql_to_utc_stamp(sql_time):
    """'2026-08-09 00:12:00' (SQLite UTC) -> '20260809T001200Z'."""
    if not sql_time:
        return utc_stamp()
    try:
        dt = datetime.datetime.strptime(str(sql_time)[:19], "%Y-%m-%d %H:%M:%S")
        return dt.strftime("%Y%m%dT%H%M%SZ")
    except ValueError:
        return utc_stamp()


def stamp_to_sql(stamp):
    """'20260809T001200Z' or '20260809' -> '2026-08-09 00:12:00'."""
    if not stamp:
        return None
    s = stamp.strip().rstrip("Z")
    for fmt in ("%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            return datetime.datetime.strptime(s, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return None


def build_vtodo(task, tags, uid, sequence=0):
    """Render a task as a VTODO. Only fields with a real value are emitted."""
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//senya-tasks//EN",
        "BEGIN:VTODO",
        f"UID:{uid}",
        f"DTSTAMP:{utc_stamp()}",
        f"CREATED:{sql_to_utc_stamp(task['created_at'])}",
        f"LAST-MODIFIED:{sql_to_utc_stamp(task['updated_at'])}",
        f"SEQUENCE:{sequence}",
        f"SUMMARY:{ical_escape(task['title'])}",
        f"STATUS:{STATUS_TO_ICAL.get(task['status'], 'NEEDS-ACTION')}",
        f"PRIORITY:{PRIORITY_TO_ICAL.get(task['priority'], 5)}",
    ]
    if task["notes"]:
        lines.append(f"DESCRIPTION:{ical_escape(task['notes'])}")
    if task["due_date"]:
        lines.append(f"DUE;VALUE=DATE:{task['due_date'].replace('-', '')}")
    if task["status"] == "done":
        lines.append(f"COMPLETED:{sql_to_utc_stamp(task['completed_at'])}")
        lines.append("PERCENT-COMPLETE:100")
    if tags:
        lines.append("CATEGORIES:" + ",".join(ical_escape(t) for t in tags))
    # `blocked` has no iCalendar equivalent; keep it in an X-prop so a round
    # trip through the server doesn't quietly downgrade it to plain todo.
    if task["status"] == "blocked":
        lines.append("X-SENYA-STATUS:blocked")
    if task["position"]:
        lines.append(f"X-APPLE-SORT-ORDER:{task['position']}")
    lines += ["END:VTODO", "END:VCALENDAR"]
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def parse_vtodo(text):
    """Pull the fields we understand out of a VTODO. None if there isn't one."""
    body = unfold(text)
    if "BEGIN:VTODO" not in body:
        return None
    section = body.split("BEGIN:VTODO", 1)[1].split("END:VTODO", 1)[0]

    props = {}
    for line in section.split("\n"):
        line = line.strip()
        if not line or ":" not in line:
            continue
        head, value = line.split(":", 1)
        name, *params = head.split(";")
        props[name.upper()] = (value, params)

    def val(name, default=None):
        return props[name][0] if name in props else default

    status = ICAL_TO_STATUS.get((val("STATUS") or "NEEDS-ACTION").upper(), "todo")
    if (val("X-SENYA-STATUS") or "").lower() == "blocked" and status == "todo":
        status = "blocked"

    try:
        prio = int(val("PRIORITY", "5") or 5)
    except ValueError:
        prio = 5
    priority = "high" if 1 <= prio <= 4 else "low" if prio >= 6 else "medium"

    due = val("DUE")
    if due:
        due = due.strip().rstrip("Z")[:8]
        due = f"{due[0:4]}-{due[4:6]}-{due[6:8]}" if len(due) == 8 else None

    cats = val("CATEGORIES", "") or ""
    tags = [ical_unescape(c).strip().lower().replace(" ", "-")
            for c in cats.split(",") if c.strip()]

    return {
        "uid": val("UID"),
        "title": ical_unescape(val("SUMMARY", "") or "").strip(),
        "notes": ical_unescape(val("DESCRIPTION", "") or "").strip(),
        "status": status,
        "priority": priority,
        "due_date": due,
        "completed_at": stamp_to_sql(val("COMPLETED")),
        "tags": sorted(dict.fromkeys(tags)),
        "last_modified": stamp_to_sql(val("LAST-MODIFIED")) or stamp_to_sql(val("DTSTAMP")),
        "sequence": int(val("SEQUENCE", "0") or 0),
    }


# ---- DAV client -----------------------------------------------------------

class CalDAVError(RuntimeError):
    pass


class Client:
    def __init__(self, url, user, password, auth="auto", timeout=20):
        if not url.endswith("/"):
            url += "/"
        self.url = url
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "senya-tasks/1.0"
        self._user, self._password, self._auth_mode = user, password, auth
        self.session.auth = self._make_auth(auth)

    def _make_auth(self, mode):
        if mode == "basic":
            return HTTPBasicAuth(self._user, self._password)
        if mode == "digest":
            return HTTPDigestAuth(self._user, self._password)
        return None  # resolved by probe()

    def probe(self):
        """Settle on the scheme the server actually asks for.

        Getting this wrong is a silent 401 loop rather than an error, so it's
        worth one request at startup: Baikal defaults to Digest, Nextcloud is
        Basic, and the same deployment can change under you.
        """
        if self._auth_mode in ("basic", "digest"):
            return self._auth_mode
        r = self.session.request("PROPFIND", self.url, headers={"Depth": "0"},
                                 timeout=self.timeout)
        scheme = "basic"
        if r.status_code == 401:
            challenge = r.headers.get("WWW-Authenticate", "").lower()
            scheme = "digest" if challenge.startswith("digest") else "basic"
        self._auth_mode = scheme
        self.session.auth = self._make_auth(scheme)
        return scheme

    def _request(self, method, url, **kw):
        kw.setdefault("timeout", self.timeout)
        r = self.session.request(method, url, **kw)
        if r.status_code == 401:
            raise CalDAVError(
                "The server rejected those credentials (401). Check the username "
                "and password, and try setting Auth explicitly — Baikal uses "
                "digest, Nextcloud uses basic.")
        return r

    # hrefs are stored and compared in exactly one form — the server-relative
    # path — because the server reports paths in sync deltas while our own
    # requests need absolute URLs. Mixing the two silently breaks every lookup
    # keyed on href (they compare unequal for the same object).
    @property
    def root(self):
        return re.match(r"^(https?://[^/]+)", self.url).group(1)

    def path_of(self, href):
        return href[len(self.root):] if href.startswith(self.root) else href

    def abs_url(self, href):
        if href.startswith("http://") or href.startswith("https://"):
            return href
        return self.root + href

    def sync_collection(self, token):
        """RFC 6578 delta. Returns (changed_hrefs, removed_hrefs, new_token)."""
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:sync-collection xmlns:d="DAV:">'
            f'<d:sync-token>{token or ""}</d:sync-token>'
            '<d:sync-level>1</d:sync-level>'
            '<d:prop><d:getetag/></d:prop>'
            '</d:sync-collection>'
        )
        r = self._request("REPORT", self.url,
                          data=body.encode("utf-8"),
                          headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"})
        if r.status_code in (400, 403, 409, 415, 501):
            return None, None, None      # server won't do sync-collection
        if r.status_code >= 400:
            raise CalDAVError(f"sync-collection failed: HTTP {r.status_code}")

        root = ET.fromstring(r.content)
        changed, removed = {}, []
        for resp in root.findall("d:response", NS):
            href = (resp.findtext("d:href", "", NS) or "").strip()
            status = resp.findtext("d:status", "", NS) or ""
            inner = resp.findtext("d:propstat/d:status", "", NS) or ""
            etag = (resp.findtext("d:propstat/d:prop/d:getetag", "", NS) or "").strip('"')
            href = self.path_of(href)
            if "404" in status:
                removed.append(href)
            elif href.endswith(".ics") and ("200" in inner or not inner):
                # ETag comes back with the delta, so our own writes can be
                # recognised and skipped without a GET (see sync_once).
                changed[href] = etag
        new_token = root.findtext("d:sync-token", None, NS)
        return changed, removed, new_token

    def list_all(self):
        """Fallback when there's no usable sync-token: every .ics + its ETag."""
        body = ('<?xml version="1.0" encoding="utf-8"?>'
                '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>')
        r = self._request("PROPFIND", self.url, data=body.encode("utf-8"),
                          headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"})
        if r.status_code >= 400:
            raise CalDAVError(f"PROPFIND failed: HTTP {r.status_code}")
        root = ET.fromstring(r.content)
        out = {}
        for resp in root.findall("d:response", NS):
            href = (resp.findtext("d:href", "", NS) or "").strip()
            etag = resp.findtext("d:propstat/d:prop/d:getetag", None, NS)
            if href.endswith(".ics"):
                out[self.path_of(href)] = (etag or "").strip('"')
        return out

    def describe(self):
        """Probe the collection: reachable, authenticated, and can it hold tasks?

        The last part matters — a calendar that only advertises VEVENT accepts
        the connection happily and then silently refuses every VTODO, which is
        an infuriating way to discover a misconfiguration hours later.
        """
        body = ('<?xml version="1.0" encoding="utf-8"?>'
                '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                '<d:prop><d:displayname/><d:resourcetype/>'
                '<c:supported-calendar-component-set/></d:prop></d:propfind>')
        r = self._request("PROPFIND", self.url, data=body.encode("utf-8"),
                          headers={"Depth": "0", "Content-Type": "application/xml; charset=utf-8"})
        if r.status_code >= 400:
            raise CalDAVError(f"the server answered HTTP {r.status_code} for that URL")
        root = ET.fromstring(r.content)
        comps = [c.get("name", "").upper()
                 for c in root.iter("{urn:ietf:params:xml:ns:caldav}comp")]
        is_cal = root.find(".//{urn:ietf:params:xml:ns:caldav}calendar") is not None
        return {
            "displayname": (root.findtext(".//d:displayname", "", NS) or "").strip(),
            "is_calendar": is_cal,
            "components": comps,
            "supports_vtodo": ("VTODO" in comps) or not comps,
        }

    def get(self, href):
        r = self._request("GET", self.abs_url(href))
        if r.status_code == 404:
            return None, None
        if r.status_code >= 400:
            raise CalDAVError(f"GET {href} failed: HTTP {r.status_code}")
        return r.text, (r.headers.get("ETag") or "").strip('"')

    def put(self, href, ical, etag=None):
        headers = {"Content-Type": "text/calendar; charset=utf-8"}
        # If-Match/If-None-Match make the write conditional, so a change that
        # landed since our last poll produces a 412 instead of being overwritten.
        if etag:
            headers["If-Match"] = f'"{etag}"'
        else:
            headers["If-None-Match"] = "*"
        r = self._request("PUT", self.abs_url(href), data=ical.encode("utf-8"),
                          headers=headers)
        if r.status_code == 412:
            return None          # caller re-reads and resolves
        if r.status_code >= 400:
            raise CalDAVError(f"PUT {href} failed: HTTP {r.status_code} {r.text[:200]}")
        new_etag = (r.headers.get("ETag") or "").strip('"')
        if not new_etag:                       # sabre/dav omits it on some paths
            _, new_etag = self.get(href)
        return new_etag or ""

    def delete(self, href, etag=None):
        headers = {"If-Match": f'"{etag}"'} if etag else {}
        r = self._request("DELETE", self.abs_url(href), headers=headers)
        if r.status_code in (404, 412):
            return False
        if r.status_code >= 400:
            raise CalDAVError(f"DELETE {href} failed: HTTP {r.status_code}")
        return True


# ---- local side -----------------------------------------------------------

def state_get(conn, key, default=None):
    row = conn.execute("SELECT value FROM caldav_state WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def state_set(conn, key, value):
    conn.execute("INSERT INTO caldav_state (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def task_tags(conn, task_id):
    return [r[0] for r in conn.execute(
        "SELECT t.name FROM task_tags tt JOIN tags t ON t.id = tt.tag_id "
        "WHERE tt.task_id = ? ORDER BY t.name", (task_id,))]


def set_tags(conn, task_id, names):
    conn.execute("DELETE FROM task_tags WHERE task_id = ?", (task_id,))
    for name in sorted({n.strip().lower() for n in names if n.strip()}):
        conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        conn.execute("INSERT INTO task_tags (task_id, tag_id) "
                     "VALUES (?, (SELECT id FROM tags WHERE name = ?))", (task_id, name))


def touched_at(conn, task_id):
    row = conn.execute("SELECT updated_at FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return row[0] if row else None


def apply_remote(conn, parsed, href, etag, task_id=None):
    """Write a parsed VTODO into SQLite, then re-read updated_at.

    Re-reading matters: the tasks_touch trigger bumps updated_at on write, so
    bookmarking the value we *sent* would leave the row looking locally dirty
    forever and push it straight back on the next pass.
    """
    fields = {
        "title": parsed["title"] or "(untitled)",
        "notes": parsed["notes"],
        "status": parsed["status"],
        "priority": parsed["priority"],
        "due_date": parsed["due_date"],
    }
    if task_id is None:
        pos = conn.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM tasks").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO tasks (title, notes, status, priority, due_date, position) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (*fields.values(), pos))
        task_id = cur.lastrowid
    else:
        conn.execute(
            "UPDATE tasks SET title = ?, notes = ?, status = ?, priority = ?, due_date = ? "
            "WHERE id = ?", (*fields.values(), task_id))

    if parsed["status"] == "done" and parsed["completed_at"]:
        conn.execute("UPDATE tasks SET completed_at = ? WHERE id = ?",
                     (parsed["completed_at"], task_id))
    set_tags(conn, task_id, parsed["tags"])

    conn.execute(
        "INSERT INTO caldav_map (task_id, uid, href, etag, local_rev, remote_rev, sequence) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(task_id) DO UPDATE SET uid=excluded.uid, href=excluded.href, "
        "etag=excluded.etag, local_rev=excluded.local_rev, remote_rev=excluded.remote_rev",
        (task_id, parsed["uid"], href, etag, touched_at(conn, task_id),
         parsed["last_modified"], parsed.get("sequence") or 0))
    return task_id


def push_task(conn, client, task, row=None):
    """PUT one task. Returns "ok", "conflict" (server won) or "skipped"."""
    uid = row["uid"] if row else f"senya-{uuid.uuid4()}"
    href = client.path_of(row["href"]) if row else client.path_of(client.url) + uid + ".ics"
    tags = task_tags(conn, task["id"])
    # Monotonic per object: a client that sees SEQUENCE go backwards treats the
    # update as stale and may ignore it entirely.
    seq = (row["sequence"] if row and row["sequence"] is not None else 0) + 1
    ical = build_vtodo(task, tags, uid, sequence=seq)

    etag = client.put(href, ical, etag=row["etag"] if row else None)
    if etag is None:
        return "conflict"          # 412: someone else wrote first
    conn.execute(
        "INSERT INTO caldav_map (task_id, uid, href, etag, local_rev, remote_rev, sequence) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(task_id) DO UPDATE SET uid=excluded.uid, href=excluded.href, "
        "etag=excluded.etag, local_rev=excluded.local_rev, remote_rev=excluded.remote_rev, "
        "sequence=excluded.sequence",
        (task["id"], uid, href, etag, task["updated_at"],
         sql_to_utc_stamp(task["updated_at"]), seq))
    return "ok"


def sync_once(conn, client):
    """One full pass. Returns a small dict of counts for logging/tests."""
    stats = {"pulled": 0, "pushed": 0, "deleted_remote": 0, "deleted_local": 0,
             "conflicts": 0, "errors": 0}

    # ---- 0. local deletions -> remote, FIRST ----
    # Before anything is pulled. A task deleted locally still exists on the
    # server until we say otherwise, and its mapping is already gone (the
    # trigger moved it to a tombstone) — so if the pull ran first it would see
    # an unmapped object and helpfully recreate the task you just deleted.
    pending_deletes = {t["href"] for t in conn.execute("SELECT href FROM caldav_tombstones")}
    for tomb in conn.execute("SELECT * FROM caldav_tombstones").fetchall():
        try:
            client.delete(tomb["href"])
            conn.execute("DELETE FROM caldav_tombstones WHERE uid = ?", (tomb["uid"],))
            stats["deleted_remote"] += 1
        except (CalDAVError, requests.RequestException) as e:
            stats["errors"] += 1
            log.warning("caldav: remote delete %s failed: %s", tomb["href"], e)
    conn.commit()

    token = state_get(conn, "sync_token")
    changed, removed, new_token = client.sync_collection(token)

    known_etags = {r["href"]: r["etag"] for r in
                   conn.execute("SELECT href, etag FROM caldav_map")}

    if changed is None:                       # no sync-collection support
        listing = client.list_all()
        changed = {h: e for h, e in listing.items() if known_etags.get(h) != e}
        removed = [h for h in known_etags if h not in listing]
        new_token = None

    # ---- 1. remote -> local ----
    for href, delta_etag in changed.items():
        # Our own PUT bumps the collection's sync-token, so the object we just
        # wrote comes back in the next delta. Recognising it by ETag skips a
        # pointless GET *and* avoids re-applying our own data, which would bump
        # updated_at and make the task look edited when nothing touched it.
        if delta_etag and known_etags.get(href) == delta_etag:
            continue
        # Belt and braces against resurrection: even if a delete failed above
        # and its tombstone is still pending, never recreate the task from it.
        if href in pending_deletes:
            continue
        try:
            text, etag = client.get(href)
            if text is None:
                continue
            parsed = parse_vtodo(text)
            if not parsed or not parsed["uid"]:
                continue                       # VEVENT or junk: not ours
            row = conn.execute(
                "SELECT * FROM caldav_map WHERE href = ? OR uid = ?",
                (href, parsed["uid"])).fetchone()
            if row is None:
                apply_remote(conn, parsed, href, etag)
                stats["pulled"] += 1
                continue

            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (row["task_id"],)).fetchone()
            if task is None:                   # local row vanished; treat as new
                apply_remote(conn, parsed, href, etag)
                stats["pulled"] += 1
                continue

            local_dirty = task["updated_at"] != row["local_rev"]
            if local_dirty:
                stats["conflicts"] += 1
                remote_newer = (parsed["last_modified"] or "") > (task["updated_at"] or "")
                log.warning("caldav: conflict on %r — %s wins", task["title"],
                            "server" if remote_newer else "local")
                if not remote_newer:
                    continue                   # push step will overwrite it
            apply_remote(conn, parsed, href, etag, task_id=row["task_id"])
            stats["pulled"] += 1
        except (CalDAVError, requests.RequestException, ET.ParseError) as e:
            stats["errors"] += 1
            log.warning("caldav: pull %s failed: %s", href, e)

    # ---- 2. remote deletions -> local ----
    for href in removed or []:
        row = conn.execute("SELECT * FROM caldav_map WHERE href = ?", (href,)).fetchone()
        if not row:
            continue
        task = conn.execute("SELECT title, updated_at FROM tasks WHERE id = ?",
                            (row["task_id"],)).fetchone()
        if task and task["updated_at"] != row["local_rev"]:
            log.warning("caldav: %r was deleted on the server but had unsynced local "
                        "edits — the local copy is being removed too", task["title"])
        # Drop the mapping first so the delete trigger doesn't write a tombstone
        # and bounce the deletion straight back at the server.
        conn.execute("DELETE FROM caldav_map WHERE task_id = ?", (row["task_id"],))
        conn.execute("DELETE FROM tasks WHERE id = ?", (row["task_id"],))
        conn.execute("DELETE FROM caldav_tombstones WHERE uid = ?", (row["uid"],))
        stats["deleted_local"] += 1

    # ---- 3. local -> remote ----
    dirty = conn.execute(
        "SELECT t.* FROM tasks t LEFT JOIN caldav_map m ON m.task_id = t.id "
        "WHERE m.task_id IS NULL OR m.local_rev IS NOT t.updated_at").fetchall()
    for task in dirty:
        row = conn.execute("SELECT * FROM caldav_map WHERE task_id = ?", (task["id"],)).fetchone()
        try:
            result = push_task(conn, client, task, row)
            if result == "ok":
                stats["pushed"] += 1
            elif result == "conflict":
                stats["conflicts"] += 1
                text, etag = client.get(row["href"]) if row else (None, None)
                parsed = parse_vtodo(text) if text else None
                if parsed:
                    apply_remote(conn, parsed, row["href"], etag, task_id=task["id"])
                    log.warning("caldav: %r changed on the server first — server wins",
                                task["title"])
        except (CalDAVError, requests.RequestException) as e:
            stats["errors"] += 1
            log.warning("caldav: push %r failed: %s", task["title"], e)

    if new_token and not stats["errors"]:
        state_set(conn, "sync_token", new_token)
    state_set(conn, "last_sync", datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
    conn.commit()
    return stats


# ---- background worker ----------------------------------------------------

_worker = None
# One pass at a time. The timer and POST /api/caldav/sync can otherwise overlap
# and both decide the same task is dirty — double PUTs, and two writers racing
# on the same SQLite rows.
_sync_lock = threading.Lock()


def status(conn):
    return {
        "enabled": CONFIG["enabled"],
        "url": CONFIG["url"],
        "user": CONFIG["user"],
        "auth": CONFIG["auth"],
        # deliberately never the password itself
        "password_set": bool(CONFIG["password"]),
        "configured": bool(CONFIG["url"] and CONFIG["user"] and CONFIG["password"]),
        "interval": CONFIG["interval"],
        "last_sync": state_get(conn, "last_sync"),
        "last_result": state_get(conn, "last_result"),
        "worker_running": bool(_worker and _worker.is_alive()),
        "auth_scheme": state_get(conn, "auth_scheme"),
        "mapped": conn.execute("SELECT COUNT(*) FROM caldav_map").fetchone()[0],
        "pending_deletes": conn.execute("SELECT COUNT(*) FROM caldav_tombstones").fetchone()[0],
    }


def test_connection(conn, values=None):
    """Try the settings without saving them, and report what's wrong in words.

    Called from the UI's "Test" button: the point is that a misconfiguration is
    named here rather than discovered as silence hours later.
    """
    cfg = dict(CONFIG)
    if values:
        for k in ("url", "user", "auth"):
            if values.get(k):
                cfg[k] = values[k].strip()
        if values.get("password"):
            cfg["password"] = values["password"]
    if not cfg["url"] or not cfg["user"]:
        return {"ok": False, "message": "Enter a calendar URL and username first."}
    if not cfg["password"]:
        return {"ok": False, "message": "No password set for this account yet."}
    if not cfg["url"].endswith("/"):
        cfg["url"] += "/"

    client = Client(cfg["url"], cfg["user"], cfg["password"],
                    auth=cfg["auth"], timeout=cfg["timeout"])
    try:
        scheme = client.probe()
        info = client.describe()
    except CalDAVError as e:
        return {"ok": False, "message": str(e)}
    except requests.RequestException as e:
        return {"ok": False, "message": f"Could not reach the server: {e}"}
    except ET.ParseError:
        return {"ok": False,
                "message": "That URL answered, but not with CalDAV — is it the "
                           "calendar collection rather than the server root?"}

    if not info["is_calendar"]:
        return {"ok": False, "scheme": scheme,
                "message": "That URL is not a calendar collection. It should end "
                           "with the calendar itself, e.g. .../calendars/Senya/default/"}
    if not info["supports_vtodo"]:
        return {"ok": False, "scheme": scheme, "components": info["components"],
                "message": f"This calendar only holds {', '.join(info['components'])} — "
                           "it can't store tasks. Use a calendar with VTODO enabled."}
    try:
        count = len(client.list_all())
    except (CalDAVError, requests.RequestException):
        count = None
    return {
        "ok": True,
        "scheme": scheme,
        "displayname": info["displayname"],
        "components": info["components"],
        "remote_objects": count,
        "message": f"Connected to “{info['displayname'] or 'calendar'}” as {cfg['user']} "
                   f"({scheme} auth)" + (f" · {count} items already there" if count is not None else ""),
    }


def run_once(connect_fn, blocking=True):
    """One sync pass on its own connection. Safe to call from a request."""
    if not CONFIG["enabled"]:
        return {"skipped": "CALDAV_ENABLED is false"}
    if not (CONFIG["url"] and CONFIG["user"]):
        return {"skipped": "CALDAV_URL / CALDAV_USER not set"}
    if not _sync_lock.acquire(blocking=blocking, timeout=60 if blocking else -1):
        return {"skipped": "a sync is already running"}
    conn = connect_fn()
    try:
        client = Client(CONFIG["url"], CONFIG["user"], CONFIG["password"],
                        auth=CONFIG["auth"], timeout=CONFIG["timeout"])
        # Remember what the server asked for, so a restart doesn't re-probe and
        # a server that switches scheme is picked up on the next pass.
        cached = state_get(conn, "auth_scheme")
        if CONFIG["auth"] == "auto" and cached in ("basic", "digest"):
            client._auth_mode = cached
            client.session.auth = client._make_auth(cached)
        else:
            state_set(conn, "auth_scheme", client.probe())
            conn.commit()
        try:
            stats = sync_once(conn, client)
        except CalDAVError as e:
            # Most likely the cached scheme went stale (Baikal flipping between
            # Digest and Basic does exactly this) — re-probe once and retry.
            if "401" not in str(e):
                raise
            log.info("caldav: auth rejected, re-probing scheme")
            state_set(conn, "auth_scheme", client.probe())
            conn.commit()
            stats = sync_once(conn, client)
        state_set(conn, "last_result", str(stats))
        conn.commit()
        return stats
    finally:
        conn.close()
        _sync_lock.release()


def start_worker(connect_fn):
    """Poll in the background. Never on the request path: a hung or absent
    CalDAV server would otherwise stall the API on every write."""
    global _worker
    if _worker:
        return

    def loop():
        time.sleep(5)                       # let the app finish booting
        while True:
            try:
                # Re-read every pass so saving settings in the UI takes effect
                # on the next tick instead of needing a container restart.
                conn = connect_fn()
                try:
                    load_config(conn)
                finally:
                    conn.close()
                if CONFIG["enabled"]:
                    stats = run_once(connect_fn)
                    if any(stats.get(k) for k in ("pulled", "pushed", "deleted_remote",
                                                  "deleted_local", "conflicts")):
                        log.info("caldav: %s", stats)
            except Exception as e:          # a worker thread must never die
                log.warning("caldav: sync pass failed: %s", e)
            time.sleep(max(30, CONFIG["interval"]))

    _worker = threading.Thread(target=loop, name="caldav-sync", daemon=True)
    _worker.start()
    log.info("caldav: worker started (enabled=%s, every %ss)",
             CONFIG["enabled"], CONFIG["interval"])
