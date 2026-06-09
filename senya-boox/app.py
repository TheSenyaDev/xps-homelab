"""
SenyaBoox — a browse / view web app for the PDF notes your Onyx Boox exports
over WebDAV to the homelab.

Flask + vanilla JS, and deliberately *dumb*: it reads (never writes) `.pdf` files
from a mounted folder and serves them so the browser's built-in PDF viewer can
render them. That folder is the WebDAV share the Boox syncs into:

    Boox ──WebDAV──► ./webdav/data/*.pdf ◄── this app (read-only)

Every request is sandboxed to inside the notes root; only `.pdf` files are
listed or served.
"""

import os
import re

from flask import Flask, abort, jsonify, request, send_from_directory

# Root of the WebDAV share, mounted read-only (the Boox writes here, not us).
NOTES_DIR = os.path.realpath(os.environ.get("NOTES_DIR", "/notes"))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Never surface dotfiles/dotdirs (e.g. WebDAV/sync scratch files).
HIDDEN_RE = re.compile(r"^\.")

app = Flask(__name__, static_folder=None)


# ----- path safety -----

def safe_abs(rel):
    """Resolve a client-supplied relative path to an absolute path provably
    inside NOTES_DIR. Returns None if it escapes the root."""
    if not rel or "\x00" in rel:
        return None
    rel = rel.lstrip("/")
    candidate = os.path.normpath(os.path.join(NOTES_DIR, rel))
    real = os.path.realpath(candidate)
    if real != NOTES_DIR and not real.startswith(NOTES_DIR + os.sep):
        return None
    return real


def is_pdf(name):
    return name.lower().endswith(".pdf")


# ----- tree -----

def build_tree(abs_dir, rel_dir=""):
    """Recursively list folders and .pdf files. Each node:
    {name, path, type: 'dir'|'file', mtime?, size?, children?}. Folders sort
    first, then files (case-insensitive). Empty folders are omitted."""
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
            if children:  # skip folders with no PDFs in them
                nodes.append({"name": e.name, "path": rel, "type": "dir",
                              "children": children})
        elif e.is_file(follow_symlinks=False) and is_pdf(e.name):
            try:
                st = e.stat()
                mtime, size = st.st_mtime, st.st_size
            except OSError:
                mtime, size = None, None
            nodes.append({"name": e.name, "path": rel, "type": "file",
                          "mtime": mtime, "size": size})
    nodes.sort(key=lambda n: (n["type"] != "dir", n["name"].lower()))
    return nodes


@app.get("/api/tree")
def tree():
    nodes = build_tree(NOTES_DIR)
    count = sum(1 for _ in _iter_files(nodes))
    return jsonify({"root": os.path.basename(NOTES_DIR) or "notes",
                    "count": count, "tree": nodes})


def _iter_files(nodes):
    for n in nodes:
        if n["type"] == "file":
            yield n
        else:
            yield from _iter_files(n.get("children", []))


# ----- serve a PDF -----

@app.get("/api/pdf")
def pdf():
    """Stream a PDF for inline viewing. ?download=1 forces a save dialog."""
    rel = request.args.get("path", "")
    if not is_pdf(rel):
        abort(400)
    path = safe_abs(rel)
    if path is None or not os.path.isfile(path):
        abort(404)
    download = request.args.get("download") == "1"
    # send_from_directory needs the dir + basename split from the *real* path.
    directory, name = os.path.split(path)
    return send_from_directory(directory, name, mimetype="application/pdf",
                               as_attachment=download,
                               download_name=os.path.basename(rel))


# ----- health -----

@app.get("/api/health")
def health():
    exists = os.path.isdir(NOTES_DIR)
    count = sum(1 for _ in _iter_files(build_tree(NOTES_DIR))) if exists else 0
    status = "ok" if exists else "error"
    return jsonify({"status": status, "notes_dir": NOTES_DIR,
                    "exists": exists, "pdfs": count})


# ----- static frontend -----

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8004)
