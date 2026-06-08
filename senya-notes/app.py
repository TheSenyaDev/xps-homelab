"""
SenyaNotes — a plain-markdown browse / read / edit web app for the senya homelab.

Flask + vanilla JS. It is deliberately *dumb*: it reads and writes `.md` files in
a mounted folder and knows nothing about Obsidian's sync format. That folder is
produced by the `livesync-bridge` sidecar, which materializes the LiveSync CouchDB
vault into plain files (and pushes our edits back up). So:

    Obsidian (phone/desktop) ──► CouchDB ──livesync-bridge──► /vault/*.md ◄── this app

Writes are atomic (tmp + os.replace) so the bridge never reads a half-written
file, and every request is sandboxed to inside the vault root.
"""

import base64
import json
import os
import re
import urllib.error
import urllib.request

from flask import Flask, jsonify, request, send_from_directory

# Root of the materialized vault (the livesync-bridge `storage` output).
VAULT_DIR = os.path.realpath(os.environ.get("VAULT_DIR", "/vault"))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# CouchDB coordinates for the health check. This app never reads notes from
# CouchDB (the bridge decodes those to files) — it only pings the DB to confirm
# the same backend the bridge replicates against is alive. Same vars as the
# livesync-bridge service, passed through in docker-compose.
COUCHDB_URL = os.environ.get("LIVESYNC_COUCHDB_URL", "http://obsidian-couchdb:5984").rstrip("/")
COUCHDB_DB = os.environ.get("LIVESYNC_DATABASE", "obsidian")
COUCHDB_USER = os.environ.get("COUCHDB_USER", "")
COUCHDB_PASSWORD = os.environ.get("COUCHDB_PASSWORD", "")

# Files/dirs we never surface in the tree: dotfiles (incl. .obsidian, .trash),
# and the plugin's sync-internal folders.
HIDDEN_RE = re.compile(r"^\.")

app = Flask(__name__, static_folder=None)


# ----- path safety -----

def safe_abs(rel):
    """Resolve a client-supplied relative path to an absolute path that is
    provably inside VAULT_DIR. Returns None if it escapes or looks malicious.

    Works for not-yet-existing files (new notes) by resolving the *parent* and
    re-appending the basename, so symlink tricks on existing dirs are caught
    while a fresh filename is still allowed.
    """
    if not rel or "\x00" in rel:
        return None
    rel = rel.lstrip("/")
    candidate = os.path.normpath(os.path.join(VAULT_DIR, rel))
    parent = os.path.dirname(candidate)
    real_parent = os.path.realpath(parent)
    # parent must be the vault root or live inside it
    if real_parent != VAULT_DIR and not real_parent.startswith(VAULT_DIR + os.sep):
        return None
    final = os.path.join(real_parent, os.path.basename(candidate))
    if final != VAULT_DIR and not final.startswith(VAULT_DIR + os.sep):
        return None
    return final


def is_md(name):
    return name.lower().endswith(".md")


# ----- tree -----

def build_tree(abs_dir, rel_dir=""):
    """Recursively list folders and .md files under abs_dir as a nested tree.
    Each node: {name, path, type: 'dir'|'file', children?}. Folders sort first,
    then files, both case-insensitively. Empty folders are omitted."""
    nodes = []
    try:
        entries = sorted(os.scandir(abs_dir), key=lambda e: e.name.lower())
    except FileNotFoundError:
        return nodes
    for e in entries:
        if HIDDEN_RE.match(e.name):
            continue
        rel = f"{rel_dir}/{e.name}" if rel_dir else e.name
        if e.is_dir(follow_symlinks=False):
            children = build_tree(e.path, rel)
            if children:  # skip folders with no notes in them
                nodes.append({"name": e.name, "path": rel, "type": "dir",
                              "children": children})
        elif e.is_file(follow_symlinks=False) and is_md(e.name):
            nodes.append({"name": e.name, "path": rel, "type": "file"})
    # folders before files
    nodes.sort(key=lambda n: (n["type"] != "dir", n["name"].lower()))
    return nodes


@app.get("/api/tree")
def tree():
    return jsonify({"vault": os.path.basename(VAULT_DIR) or "vault",
                    "tree": build_tree(VAULT_DIR)})


# ----- read / write / new / delete -----

@app.get("/api/file")
def read_file():
    rel = request.args.get("path", "")
    if not is_md(rel):
        return jsonify({"error": "not a markdown file"}), 400
    path = safe_abs(rel)
    if path is None:
        return jsonify({"error": "bad path"}), 400
    if not os.path.isfile(path):
        return jsonify({"error": "not found"}), 404
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return jsonify({"path": rel, "content": content,
                    "mtime": os.path.getmtime(path)})


@app.put("/api/file")
def write_file():
    data = request.get_json(force=True) or {}
    rel = data.get("path", "")
    if not is_md(rel):
        return jsonify({"error": "not a markdown file"}), 400
    path = safe_abs(rel)
    if path is None:
        return jsonify({"error": "bad path"}), 400
    content = data.get("content")
    if not isinstance(content, str):
        return jsonify({"error": "content required"}), 400

    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Atomic write: the bridge's file watcher must never see a partial file.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)
    return jsonify({"path": rel, "mtime": os.path.getmtime(path)})


@app.post("/api/file")
def create_file():
    """Create a new, empty note. 409 if it already exists."""
    data = request.get_json(force=True) or {}
    rel = (data.get("path") or "").strip()
    if not rel.lower().endswith(".md"):
        rel += ".md"
    if not is_md(rel):
        return jsonify({"error": "bad name"}), 400
    path = safe_abs(rel)
    if path is None:
        return jsonify({"error": "bad path"}), 400
    if os.path.exists(path):
        return jsonify({"error": "already exists"}), 409
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("")
    return jsonify({"path": rel}), 201


@app.delete("/api/file")
def delete_file():
    rel = request.args.get("path", "")
    if not is_md(rel):
        return jsonify({"error": "not a markdown file"}), 400
    path = safe_abs(rel)
    if path is None:
        return jsonify({"error": "bad path"}), 400
    if os.path.isfile(path):
        os.remove(path)  # the bridge will replicate the deletion to CouchDB
    return "", 204


# ----- health / sync status -----

def couch_status():
    """Ping the CouchDB database the bridge replicates against. Confirms the sync
    backend is reachable; doc_count is a rough liveness signal (chunks + notes)."""
    info = {"reachable": False, "doc_count": None, "db": COUCHDB_DB, "error": None}
    req = urllib.request.Request(f"{COUCHDB_URL}/{COUCHDB_DB}")
    if COUCHDB_USER:
        token = base64.b64encode(f"{COUCHDB_USER}:{COUCHDB_PASSWORD}".encode()).decode()
        req.add_header("Authorization", "Basic " + token)
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            data = json.loads(r.read().decode())
        info["reachable"] = True
        info["doc_count"] = data.get("doc_count")
    except urllib.error.HTTPError as e:
        info["error"] = f"HTTP {e.code}"
    except Exception as e:  # connection refused, DNS, timeout, etc.
        info["error"] = type(e).__name__
    return info


def vault_status():
    """Count notes and find the most recent change — proof the bridge is writing."""
    notes, latest = 0, 0.0
    for root, dirs, files in os.walk(VAULT_DIR):
        dirs[:] = [d for d in dirs if not HIDDEN_RE.match(d)]
        for f in files:
            if is_md(f):
                notes += 1
                try:
                    m = os.path.getmtime(os.path.join(root, f))
                    latest = max(latest, m)
                except OSError:
                    pass
    return {"exists": os.path.isdir(VAULT_DIR), "notes": notes,
            "last_modified": latest or None}


@app.get("/api/health")
def health():
    couch = couch_status()
    vault = vault_status()
    # ok   = backend reachable AND files present (whole chain working)
    # warn = only one side healthy (e.g. connected but nothing synced yet, or
    #        serving cached files while CouchDB is briefly unreachable)
    # error= neither
    if couch["reachable"] and vault["notes"] > 0:
        status = "ok"
    elif couch["reachable"] or vault["notes"] > 0:
        status = "warn"
    else:
        status = "error"
    return jsonify({"status": status, "couchdb": couch, "vault": vault})


# ----- static frontend -----

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8003)
