"""sync_once() against a fake, in-memory CalDAV server.

Covers the four cases the module's docstring names as the whole point of the
`caldav_map` bookmark (neither dirty / local only / remote only / both), plus
the two delete paths — using single-collection mode, which is what most
deployments run. Per-category routing is exercised at a higher level by
CALDAV.md's own manual test notes and is out of scope here.
"""
import caldav
from helpers import make_task


class FakeClient:
    """A CalDAV collection in memory: enough of Client's surface for
    sync_once() to run against, with a generation counter standing in for
    real WebDAV-Sync tokens (sync-collection deltas are "what changed since
    generation N", same shape as the real RFC 6578 report)."""

    def __init__(self, home="/cal/"):
        self.url = home
        self.gen = 0
        self.objects = {}       # href -> {"text", "etag", "gen"}
        self.removed_log = []   # (href, gen)

    def path_of(self, href):
        return href

    def sync_collection(self, token, url=None):
        base = url or self.url
        since = int(token) if token else 0
        changed = {h: o["etag"] for h, o in self.objects.items()
                   if h.startswith(base) and o["gen"] > since}
        removed = [h for h, g in self.removed_log if h.startswith(base) and g > since]
        return changed, removed, str(self.gen)

    def get(self, href):
        o = self.objects.get(href)
        return (None, None) if o is None else (o["text"], o["etag"])

    def put(self, href, ical, etag=None):
        existing = self.objects.get(href)
        if etag is not None:
            if existing is None or existing["etag"] != etag:
                return None                    # simulated 412
        elif existing is not None:
            return None                        # If-None-Match: * clashes
        self.gen += 1
        new_etag = f"e{self.gen}"
        self.objects[href] = {"text": ical, "etag": new_etag, "gen": self.gen}
        return new_etag

    def delete(self, href, etag=None):
        if href not in self.objects:
            return False
        del self.objects[href]
        self.gen += 1
        self.removed_log.append((href, self.gen))
        return True

    def inject_remote_object(self, href, ical):
        """Simulate a VTODO created or edited directly on the server."""
        self.gen += 1
        self.objects[href] = {"text": ical, "etag": f"e{self.gen}", "gen": self.gen}


def remote_task(**overrides):
    task = {
        "id": 0, "title": "From the phone", "notes": "", "status": "todo",
        "priority": "medium", "due_date": None, "position": 0,
        "created_at": "2026-08-01 09:00:00", "updated_at": "2026-08-01 09:00:00",
        "completed_at": None,
    }
    task.update(overrides)
    return task


def test_local_only_task_is_pushed(client, db):
    make_task(client, title="new local task")
    fake = FakeClient()

    stats = caldav.sync_once(db, fake)

    assert stats["pushed"] == 1
    assert stats["errors"] == 0
    assert len(fake.objects) == 1
    text = next(iter(fake.objects.values()))["text"]
    assert "SUMMARY:new local task" in text

    row = db.execute("SELECT * FROM caldav_map").fetchone()
    assert row is not None
    assert row["uid"].startswith("senya-")


def test_remote_only_object_is_pulled(db):
    fake = FakeClient()
    ical = caldav.build_vtodo(remote_task(title="From the phone"),
                              tags=["errand"], uid="senya-remote-1")
    fake.inject_remote_object(fake.url + "senya-remote-1.ics", ical)

    stats = caldav.sync_once(db, fake)

    assert stats["pulled"] == 1
    row = db.execute("SELECT * FROM tasks WHERE title = 'From the phone'").fetchone()
    assert row is not None
    tags = [r["name"] for r in db.execute(
        "SELECT t.name FROM task_tags tt JOIN tags t ON t.id = tt.tag_id "
        "WHERE tt.task_id = ?", (row["id"],))]
    assert tags == ["errand"]

    map_row = db.execute("SELECT * FROM caldav_map WHERE task_id = ?",
                         (row["id"],)).fetchone()
    assert map_row["uid"] == "senya-remote-1"


def test_neither_dirty_is_a_no_op(client, db):
    make_task(client, title="steady state")
    fake = FakeClient()
    caldav.sync_once(db, fake)   # first pass: establishes the mapping

    stats = caldav.sync_once(db, fake)   # second pass: nothing changed either side

    assert stats == {"pulled": 0, "pushed": 0, "deleted_remote": 0,
                     "deleted_local": 0, "moved": 0, "conflicts": 0, "errors": 0}


def test_conflict_when_both_sides_changed_newest_wins(client, db):
    task = make_task(client, title="Original title")
    fake = FakeClient()
    caldav.sync_once(db, fake)   # establish the mapping

    map_row = db.execute("SELECT * FROM caldav_map WHERE task_id = ?",
                         (task["id"],)).fetchone()
    href = map_row["href"]

    # local edit — force the bookmark stale explicitly rather than relying on
    # the trigger's datetime('now') to land in a different second than the
    # push above, which would make local_dirty flaky under a fast test run.
    client.patch(f"/api/tasks/{task['id']}", json={"title": "Edited locally"})
    db.execute("UPDATE caldav_map SET local_rev = '2000-01-01 00:00:00' "
               "WHERE task_id = ?", (task["id"],))
    db.commit()

    # remote edit, stamped further in the future so it should win
    edited = remote_task(title="Edited on phone", updated_at="2099-01-01 00:00:00")
    ical = caldav.build_vtodo(edited, tags=[], uid=map_row["uid"])
    fake.inject_remote_object(href, ical)

    stats = caldav.sync_once(db, fake)

    assert stats["conflicts"] == 1
    row = db.execute("SELECT title FROM tasks WHERE id = ?", (task["id"],)).fetchone()
    assert row["title"] == "Edited on phone"


def test_local_delete_pushes_a_remote_delete(client, db):
    task = make_task(client, title="delete me locally")
    fake = FakeClient()
    caldav.sync_once(db, fake)
    assert len(fake.objects) == 1

    client.delete(f"/api/tasks/{task['id']}")
    assert db.execute("SELECT COUNT(*) c FROM caldav_tombstones").fetchone()["c"] == 1

    stats = caldav.sync_once(db, fake)

    assert stats["deleted_remote"] == 1
    assert fake.objects == {}
    assert db.execute("SELECT COUNT(*) c FROM caldav_tombstones").fetchone()["c"] == 0


def test_remote_delete_pulls_a_local_delete(client, db):
    task = make_task(client, title="delete me remotely")
    fake = FakeClient()
    caldav.sync_once(db, fake)
    href = db.execute("SELECT href FROM caldav_map WHERE task_id = ?",
                      (task["id"],)).fetchone()["href"]

    fake.delete(href)   # "someone removed the reminder on their phone"

    stats = caldav.sync_once(db, fake)

    assert stats["deleted_local"] == 1
    assert db.execute("SELECT * FROM tasks WHERE id = ?", (task["id"],)).fetchone() is None
    assert db.execute("SELECT * FROM caldav_map WHERE task_id = ?",
                      (task["id"],)).fetchone() is None
