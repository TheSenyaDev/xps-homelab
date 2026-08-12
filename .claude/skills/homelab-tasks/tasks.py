#!/usr/bin/env python3
"""
Read and update homelab TODOs in SenyaTasks.

A helper rather than raw curl for one reason: the API's `category_id` filter is
an exact match, so asking for Homelab returns only tasks pinned directly to it
and silently omits everything in Senya-Tasks, Senya-Landing and the rest. Every
command here expands the subtree first.

  list [--all] [--category NAME]   open tasks (--all includes done)
  show <id>                        one task with its notes and subtasks
  done <id>                        mark complete
  reopen <id>
  note <id> <text>                 append to the task's notes
  add <title> [--category NAME] [--priority high|medium|low] [--due YYYY-MM-DD]
  sub <parent-id> <title>          add a subtask
"""
import argparse, json, sys, urllib.error, urllib.request

BASE = "http://localhost:8000"
ROOT = "Homelab"
RANK = {"high": 0, "medium": 1, "low": 2}


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"error: {e.code} {json.loads(e.read() or b'{}').get('error', e.reason)}")
    except urllib.error.URLError as e:
        sys.exit(f"error: SenyaTasks unreachable at {BASE} ({e.reason}). "
                 f"Is the container up? docker compose up -d senya-tasks")


def subtree(cats, name):
    """Category ids for `name` and everything nested under it."""
    root = next((c["id"] for c in cats if c["name"].lower() == name.lower()), None)
    if root is None:
        sys.exit(f"error: no category named {name!r}. "
                 f"Have: {', '.join(c['name'] for c in cats)}")
    ids, grew = {root}, True
    while grew:                       # cheap closure; the tree is tiny
        grew = False
        for c in cats:
            if c["parent_id"] in ids and c["id"] not in ids:
                ids.add(c["id"])
                grew = True
    return ids


def load(category):
    cats = call("GET", "/api/categories")
    return call("GET", "/api/tasks"), cats, subtree(cats, category), \
        {c["id"]: c["name"] for c in cats}


def cmd_list(a):
    tasks, _, ids, name = load(a.category)
    rows = [t for t in tasks if t["category_id"] in ids and t["parent_id"] is None
            and (a.all or not t["done"])]
    rows.sort(key=lambda t: (t["done"], RANK.get(t["priority"], 3), t["due_date"] or "9999"))
    if not rows:
        print(f"no {'' if a.all else 'open '}tasks under {a.category}")
        return
    for t in rows:
        subs = [s for s in tasks if s["parent_id"] == t["id"]]
        bits = [f"#{t['id']}", "[x]" if t["done"] else "[ ]", f"{t['priority'][:1].upper()}",
                f"{name.get(t['category_id'], '-'):<14}", t["title"]]
        if subs:
            bits.append(f"({sum(s['done'] for s in subs)}/{len(subs)} subtasks)")
        if t["due_date"]:
            bits.append(f"due {t['due_date']}")
        print("  ".join(bits))


def cmd_show(a):
    tasks = call("GET", "/api/tasks")
    t = next((x for x in tasks if x["id"] == a.id), None)
    if not t:
        sys.exit(f"error: no task #{a.id}")
    print(f"#{t['id']}  {t['title']}")
    print(f"  status={t['status']} priority={t['priority']} due={t['due_date'] or '-'}")
    if t["tags"]:
        print("  tags: " + ", ".join(x["name"] for x in t["tags"]))
    if t["notes"]:
        print("  notes:\n" + "\n".join("    " + l for l in t["notes"].split("\n")))
    for s in [x for x in tasks if x["parent_id"] == t["id"]]:
        print(f"    - [{'x' if s['done'] else ' '}] #{s['id']} {s['title']}")


def cmd_done(a):
    print(json.dumps(call("PATCH", f"/api/tasks/{a.id}", {"done": True})["title"]) + " -> done")


def cmd_reopen(a):
    print(json.dumps(call("PATCH", f"/api/tasks/{a.id}", {"done": False})["title"]) + " -> todo")


def cmd_note(a):
    tasks = call("GET", "/api/tasks")
    t = next((x for x in tasks if x["id"] == a.id), None)
    if not t:
        sys.exit(f"error: no task #{a.id}")
    text = (t["notes"] + "\n" if t["notes"] else "") + a.text
    call("PATCH", f"/api/tasks/{a.id}", {"notes": text})
    print(f"noted on #{a.id}")


def cmd_add(a):
    cats = call("GET", "/api/categories")
    cid = next((c["id"] for c in cats if c["name"].lower() == a.category.lower()), None)
    body = {"title": a.title, "category_id": cid, "priority": a.priority}
    if a.due:
        body["due_date"] = a.due
    print(f"created #{call('POST', '/api/tasks', body)['id']}")


def cmd_sub(a):
    parent = next((x for x in call("GET", "/api/tasks") if x["id"] == a.parent), None)
    if not parent:
        sys.exit(f"error: no task #{a.parent}")
    body = {"title": a.title, "parent_id": a.parent, "category_id": parent["category_id"]}
    print(f"created #{call('POST', '/api/tasks', body)['id']} under #{a.parent}")


p = argparse.ArgumentParser(description=__doc__,
                            formatter_class=argparse.RawDescriptionHelpFormatter)
sub = p.add_subparsers(dest="cmd", required=True)

s = sub.add_parser("list"); s.set_defaults(fn=cmd_list)
s.add_argument("--all", action="store_true"); s.add_argument("--category", default=ROOT)
s = sub.add_parser("show"); s.set_defaults(fn=cmd_show); s.add_argument("id", type=int)
s = sub.add_parser("done"); s.set_defaults(fn=cmd_done); s.add_argument("id", type=int)
s = sub.add_parser("reopen"); s.set_defaults(fn=cmd_reopen); s.add_argument("id", type=int)
s = sub.add_parser("note"); s.set_defaults(fn=cmd_note)
s.add_argument("id", type=int); s.add_argument("text")
s = sub.add_parser("add"); s.set_defaults(fn=cmd_add); s.add_argument("title")
s.add_argument("--category", default=ROOT); s.add_argument("--priority", default="medium")
s.add_argument("--due")
s = sub.add_parser("sub"); s.set_defaults(fn=cmd_sub)
s.add_argument("parent", type=int); s.add_argument("title")

a = p.parse_args()
a.fn(a)
