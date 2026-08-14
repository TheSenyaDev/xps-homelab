"""Tasks.md is rewritten on every mutation.

The export file is what makes the list readable from Obsidian, so it has to
track the database rather than the last time someone happened to hit /api/export.
`build_markdown` is covered in test_markdown.py; this covers the side effect —
that every mutating endpoint actually triggers it.
"""
import os

import pytest

from helpers import make_category, make_task


@pytest.fixture()
def md_path():
    return os.environ["MARKDOWN_PATH"]


def read_md(path):
    return open(path, encoding="utf-8").read() if os.path.exists(path) else ""


def test_creating_a_task_writes_the_file(client, md_path):
    make_task(client, title="written to disk")
    assert "written to disk" in read_md(md_path)


def test_updating_a_task_rewrites_the_file(client, md_path):
    task = make_task(client, title="before")
    client.patch(f"/api/tasks/{task['id']}", json={"title": "after"})

    content = read_md(md_path)
    assert "after" in content and "before" not in content


def test_deleting_a_task_rewrites_the_file(client, md_path):
    task = make_task(client, title="temporary")
    client.delete(f"/api/tasks/{task['id']}")
    assert "temporary" not in read_md(md_path)


def test_completing_a_task_updates_its_checkbox(client, md_path):
    task = make_task(client, title="finish me")
    assert "- [ ] finish me" in read_md(md_path)

    client.patch(f"/api/tasks/{task['id']}", json={"status": "done"})
    assert "- [x] finish me" in read_md(md_path)


def test_category_changes_rewrite_the_file(client, md_path):
    cat = make_category(client, name="Original")
    make_task(client, title="in a category", category_id=cat["id"])
    assert "## Original" in read_md(md_path)

    client.patch(f"/api/categories/{cat['id']}", json={"name": "Renamed"})
    content = read_md(md_path)
    assert "## Renamed" in content and "## Original" not in content


def test_tag_changes_rewrite_the_file(client, md_path):
    task = make_task(client, title="tagged", tags=["errand"])
    assert "#errand" in read_md(md_path)

    client.patch(f"/api/tasks/{task['id']}", json={"tags": []})
    assert "#errand" not in read_md(md_path)


def test_import_commit_writes_the_file(client, md_path):
    client.post("/api/import/commit", json={"items": [{"title": "imported task"}]})
    assert "imported task" in read_md(md_path)


def test_reordering_rewrites_the_file_in_the_new_order(client, md_path):
    first = make_task(client, title="alpha")
    second = make_task(client, title="beta")

    client.post("/api/tasks/reorder", json={"ids": [second["id"], first["id"]]})
    content = read_md(md_path)
    assert content.index("beta") < content.index("alpha")


def test_the_file_is_written_atomically(client, md_path):
    """tmp+rename, so Obsidian never reads a half-written file."""
    make_task(client, title="anything")
    leftovers = [f for f in os.listdir(os.path.dirname(md_path)) if f.endswith(".tmp")]
    assert leftovers == []
