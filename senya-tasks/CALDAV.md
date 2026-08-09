# CalDAV sync

Two-way sync between the `tasks` table and `VTODO`s in one or more CalDAV
calendar collections. Point it at the collection your phone's account uses and
tasks appear in **Apple Reminders**, DAVx5, Thunderbird or anything else that
speaks CalDAV.

Reminders reads `VTODO`; the Calendar app reads `VEVENT`. Tasks therefore show
up in Reminders and *not* in your calendar grid — that's correct, not a bug.

Implementation: [`caldav.py`](caldav.py). Schema: migrations **M4–M6** in
[`app.py`](app.py).

---

## Setup

⚙ in the top bar → fill in, **Test connection**, **Save**.

| Field | Meaning |
|---|---|
| **Lists** | `single` — everything in one collection · `per-category` — one collection per category |
| **Calendar URL** | single: the collection (`…/calendars/Senya/default/`)<br>per-category: the calendar **home** (`…/calendars/Senya/`) |
| **Username** | Case-sensitive. Baikal's `Senya` is not `senya` |
| **Password** | Write-only — never returned by any endpoint |
| **Auth** | `auto` probes the server once · `digest` (Baikal) · `basic` (Nextcloud) |
| **Interval** | Seconds between polls, minimum 30 |

Settings live in `caldav_state` and **override** the `CALDAV_*` environment
variables, which act as initial defaults. The worker re-reads them every pass,
so saving takes effect on the next tick without a restart.

**Test connection** reports what is actually wrong rather than a bare failure:
credentials rejected, URL isn't a calendar collection, calendar can't hold tasks
(`VEVENT`-only), host unreachable.

## Field mapping

| senya-tasks | VTODO |
|---|---|
| `title` · `notes` | `SUMMARY` · `DESCRIPTION` |
| `status` todo·doing·done | `NEEDS-ACTION` · `IN-PROCESS` · `COMPLETED` |
| `status` **blocked** | `NEEDS-ACTION` + `X-SENYA-STATUS:blocked` — no iCalendar equivalent |
| `priority` high·medium·low | `PRIORITY` 1 · 5 · 9 |
| `due_date` | `DUE;VALUE=DATE` |
| `completed_at` | `COMPLETED` + `PERCENT-COMPLETE:100` |
| `tags` | `CATEGORIES` |
| `position` | `X-APPLE-SORT-ORDER` |
| `category` | the **collection** in per-category mode; not synced in single mode |

A due *time* set on a phone is truncated to a date — the schema stores dates
only. `RRULE` recurrence is not modelled; a recurring todo created elsewhere
syncs as a single task.

## How consistency works

Every synced task keeps a bookmark in `caldav_map`: the local `updated_at` and
the remote `LAST-MODIFIED` **as of the last time the two sides agreed**. A side
is *dirty* when its current revision differs from its bookmark, which turns four
vague situations into four explicit ones:

| Dirty | Action |
|---|---|
| neither | nothing |
| local only | `PUT`, guarded by `If-Match` |
| remote only | write the VTODO into SQLite |
| both | **conflict** — newest timestamp wins, loser logged as a warning |

`If-Match` matters: a change that landed between poll and push produces a `412`
rather than silently overwriting someone else's edit. On `412` we re-read and
let the server win.

Change detection uses **WebDAV-Sync** (RFC 6578). An idle poll is one request
per collection instead of a full listing.

### Order of operations in one pass

1. **Push local deletions first.** A task deleted locally still exists on the
   server, and its mapping is already gone (a trigger moved it to a tombstone).
   If the pull ran first it would see an unmapped object and *recreate the task
   you just deleted*.
2. Provision collections (per-category mode only).
3. Fetch **every** collection's delta before acting on any of it.
4. Apply creates and updates.
5. Resolve removals — real delete, or the source half of a move?
6. Relocate tasks whose category no longer matches their collection.
7. Push dirty tasks.
8. Save sync tokens, **only if the pass was clean** — a token saved after a
   failed pass would skip the changes that were never handled.

### Three failure modes handled deliberately

**Resurrection.** Pending deletes are pushed before anything is pulled, plus a
guard so a *failed* delete still can't recreate the task.

**Ping-pong.** Our own `PUT` bumps the collection's sync-token, so the object
comes straight back in the next delta. It's recognised by ETag and skipped —
without that, sync re-applies its own writes, bumping `updated_at` and making
tasks look edited when nothing touched them.

**Move ≠ delete.** See below.

## One list per category

A Reminders list *is* a CalDAV collection — there is no folder concept inside
one, and Apple ignores `CATEGORIES` for CalDAV accounts. Per-category lists
therefore mean one collection each.

- **Creates** a `VTODO`-only calendar per category, plus an `Inbox` for
  uncategorised tasks. VTODO-only keeps them out of the Calendar app.
- **URIs come from the category id** (`senya-tasks-3/`), never its name, so
  renaming a category is a `PROPPATCH` of the display name and can't orphan the
  tasks inside.
- **Category change = `MOVE`.** Same object, new list. Delete-and-recreate would
  look to a phone like the task vanishing and an unrelated one appearing,
  losing any alarm set on it.
- **Moves on the phone come back** as category changes.
- **Deleting a category leaves its collection alone** — it may hold items added
  on the phone. Only the mapping is dropped.

Nested categories flatten: CalDAV collections have no hierarchy, so `Home` and
`Home / Garage` become sibling lists.

### The subtle part

A move is indistinguishable from a delete plus a create: the server reports a
`404` in the source collection and a new object in the destination. Handled one
collection at a time, the removal destroys the task before the creation is seen,
and it returns as a *different row* with a new id, `created_at` and position.

Hence step 3 above — **gather every delta first**, then treat a removal as a
delete only if that UID appeared nowhere else in the same pass.

## Schema

| Table | Purpose |
|---|---|
| `caldav_map` | one row per synced task: `uid`, `href`, `etag`, `local_rev`, `remote_rev`, `sequence` |
| `caldav_state` | settings (`cfg_*`), cached auth scheme, single-mode sync token, `last_sync` |
| `caldav_tombstones` | locally deleted tasks awaiting a remote `DELETE` |
| `caldav_collections` | per-category mode: `category_id` → collection `href` + its own sync token |

`caldav_map` deliberately has **no** foreign key onto `tasks`: a delete must
leave a tombstone behind, and a cascade would race the trigger that writes it.
The trigger owns the cleanup instead. `category_id = 0` is the uncategorised
bucket — categories are `AUTOINCREMENT` from 1, and a `NOT NULL` primary key
avoids SQLite's rule that NULLs are distinct in a UNIQUE index.

`SEQUENCE` is a monotonic per-object counter. It must never decrease: a client
that sees a lower `SEQUENCE` treats the update as stale and may ignore it.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/caldav` | status: mode, last sync, mapped count, pending deletes, collections |
| `PUT` | `/api/caldav/config` | save settings (blank password keeps the stored one) |
| `POST` | `/api/caldav/test` | check settings against the server without saving |
| `POST` | `/api/caldav/sync` | run a pass now |

`GET /api/caldav` never returns the password — only `password_set: true|false`.

## Operations

The **⇄ chip** in the top bar shows state at a glance: green with a relative
time, amber when a sync is overdue by 3× the interval, grey when paused. It
appears only once sync is configured.

```bash
# what the sync thinks the world looks like
curl -s localhost:8000/api/caldav | python3 -m json.tool

# force a pass and see what moved
curl -s -X POST localhost:8000/api/caldav/sync

# conflicts, dropped fields, failed moves
docker logs senya-tasks 2>&1 | grep caldav
```

### Troubleshooting

| Symptom | Cause |
|---|---|
| `401` on Test | Wrong password, or wrong username **case**. Try forcing `digest`/`basic` |
| Everything in one Reminders list | `single` mode, or the phone points at a different collection |
| Tasks don't appear in Reminders | The calendar doesn't advertise `VTODO`. Test connection says so |
| "a calendar already exists … may be in the trash" | Nextcloud soft-deletes calendars and the trashed one keeps the URI. Purge it: `occ dav:delete-calendar -f <user> <uri>` |
| Nothing syncs, no errors | Sync is off, or unconfigured — check the chip and `enabled` |

**Both sides must point at the same collection.** If your phone syncs
`…/Senya/default/` and senya-tasks syncs a different calendar, each will work
perfectly and they'll never meet.

## Security

Sync runs in a background thread with its own connection, never on the request
path — an unreachable CalDAV server can't stall the API. One pass at a time,
guarded by a lock, so the timer and a manual sync can't double-push.

The password is stored **in plaintext** in `tasks.db`. senya-tasks has no login
of its own, so that's the same trust boundary as the tasks themselves: anyone
who can reach the app on your LAN/Tailscale can already read and edit
everything. Prefer a Tailscale address over a LAN one — Basic auth base64s the
password, and only WireGuard is encrypting it.
