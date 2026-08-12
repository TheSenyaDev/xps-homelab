---
name: homelab-tasks
description: Work from the homelab TODO list in SenyaTasks. Use when the user asks what is outstanding, says "work on <task>" or "what should I do next", refers to a task by number or name, or finishes work that should be marked done. Also use before starting any homelab change, to check whether a task already describes it.
---

# Homelab tasks

The user tracks everything they want built or fixed in this homelab as tasks in
**SenyaTasks** (`http://localhost:8000`), under the **Homelab** category and its
subcategories — one per project (Senya-Tasks, Senya-Landing, Vaultwarden, …).

That list is the backlog. Read it before proposing work, and close items from it
when the work is done.

## Reading and updating

Use the helper. Do not hand-roll `curl` for this:

```bash
python3 .claude/skills/homelab-tasks/tasks.py list          # open tasks
python3 .claude/skills/homelab-tasks/tasks.py list --all    # including done
python3 .claude/skills/homelab-tasks/tasks.py show 27       # notes + subtasks
python3 .claude/skills/homelab-tasks/tasks.py sub 27 "Migrate the old rows"
python3 .claude/skills/homelab-tasks/tasks.py note 27 "Blocked on the CalDAV rename"
python3 .claude/skills/homelab-tasks/tasks.py done 27
python3 .claude/skills/homelab-tasks/tasks.py add "Rotate the Authelia secret" --priority high
```

**Why the helper and not the API directly:** `GET /api/tasks?category_id=4`
matches that column exactly, so it returns only the handful pinned directly to
Homelab and silently omits everything in the subcategories — the majority of the
list. The helper expands the subtree. A query that quietly returns a fraction of
the backlog is worse than one that fails.

If it reports the app is unreachable, start it (`docker compose up -d
senya-tasks` from the repo root) rather than working from memory of the list.

## Method for working a task

### 1. Understand it, then decide whether to ask

Read the task and its subtasks and notes (`show <id>`). Many are one line written
in a hurry and under-specify the result.

**Ask before building** when a reasonable person could deliver two different
things and the wrong one would waste the work:

- The task names a symptom, not a behaviour — "icons are small", "calendar is
  awkward" — and the fix could be a tweak or a redesign.
- It implies a visible design decision: layout, where a control lives, what a
  default is.
- It could touch data already in use: a schema change, a rename, anything
  destructive or one-way.
- Scope is genuinely open: "make X better", "add settings for Y".

Ask with `AskUserQuestion`, with concrete options — a mock, two layouts, two
scopes — not "what did you mean?". One round of questions, then build.

**Do not ask** when the task is unambiguous, when the answer is discoverable in
the code, or when a sensible default exists and is easy to change afterwards.
Asking about everything is its own failure.

### 2. Plan against the real code

Find the files first. Say what will change and what could break. If the task is
larger than it looked, say so and propose splitting it — add subtasks with
`sub <id> "..."` so the breakdown survives the conversation.

### 3. Implement

Follow the conventions already in that project — these apps are deliberately
modular (`core/` + `components/` on the frontends, one adapter file per site or
channel on the backends). Extend by adding a file or a registry entry, not by
widening a hub.

### 4. Verify — the part that matters

Nothing is done because it compiles. Every change here is deployed into a
container the user actually uses, and a broken deploy is a broken homelab.

- **Rebuild and deploy from the repo root**: `docker compose up --build -d
  <service>`. Building from inside a service directory picks up that folder's
  own compose file and fails on a container-name conflict.
- **Prove the change end to end**, not that the code exists. Call the endpoint,
  fetch the page, compare served bytes to source. State what you ran and what
  came back.
- **Frontend changes need execution, not just parsing.** These are ES modules;
  a missing import or a duplicate declaration is a runtime error that every
  static check passes. Load the module graph against a real DOM and drive the
  interactions. `node --check` and grep will not catch it — that has already
  shipped a completely dead page once.
- **Watch for swallowed errors.** The frontends catch handler exceptions into
  `console.error` so one broken component cannot blank the page. A render that
  throws therefore looks like a render that did nothing; capture `console.error`
  when testing.
- **Check the neighbours.** Re-run whatever the change could plausibly have
  broken, not only the thing you built.
- **Migrations**: confirm `PRAGMA user_version` moved on the live database, and
  that existing rows still read correctly. Never edit a shipped migration.

If verification fails, fix it before reporting. If something cannot be verified
from here — anything needing a real browser, a phone, or an external service —
say so plainly and name what the user should check.

### 5. Close the loop

- `done <id>` when the work is verified. Not before.
- If only part is finished, add subtasks for the rest and leave the task open.
- `note <id> "..."` for anything the next person needs: a decision made, a
  constraint discovered, why an obvious approach was rejected.
- If the work revealed new work, `add` it rather than letting it evaporate.

## Rules

- **Never mark a task done that you have not verified**, and never mark one done
  because the user said "thanks".
- **Never invent tasks in the list** to look productive. Add one when there is
  real follow-up work.
- **Do not renumber, delete or re-categorise** tasks unless asked. Deleting a
  parent cascades to its subtasks.
- Task text is the user's, in their words. Fix the thing it describes; do not
  rewrite the task to match what you built.
