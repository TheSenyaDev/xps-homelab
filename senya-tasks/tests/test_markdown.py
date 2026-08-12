import app as app_module
from helpers import make_category, make_task


def test_build_markdown_renders_status_priority_and_due(client, db):
    make_task(client, title="Rotate keys", priority="high",
              due_date="2026-08-01", status="doing")
    text = app_module.build_markdown(db)
    assert "- [/] Rotate keys" in text
    assert "`doing`" in text
    assert "⏫" in text          # high priority
    assert "📅 2026-08-01" in text


def test_build_markdown_renders_tags_and_notes(client, db):
    make_task(client, title="Write docs", tags=["docs", "urgent"],
              notes="line one\nline two")
    text = app_module.build_markdown(db)
    assert "#docs" in text
    assert "#urgent" in text
    assert "    line one" in text
    assert "    line two" in text


def test_build_markdown_completed_date(client, db):
    task = make_task(client, title="done thing")
    client.patch(f"/api/tasks/{task['id']}", json={"status": "done"})
    text = app_module.build_markdown(db)
    assert "- [x] done thing" in text
    assert "✅" in text


def test_build_markdown_nests_categories_by_heading_level(client, db):
    parent = make_category(client, name="Home")
    child = make_category(client, name="Garage", parent_id=parent["id"])
    make_task(client, title="oil change", category_id=child["id"])

    text = app_module.build_markdown(db)
    home_idx = text.index("## Home")
    garage_idx = text.index("### Garage")
    task_idx = text.index("oil change")
    assert home_idx < garage_idx < task_idx


def test_export_endpoint_returns_markdown(client):
    make_task(client, title="exported task")
    resp = client.get("/api/export")
    assert resp.status_code == 200
    assert "text/markdown" in resp.content_type
    assert "exported task" in resp.get_data(as_text=True)


def test_export_download_sets_content_disposition(client):
    resp = client.get("/api/export?download=1")
    assert "attachment" in resp.headers["Content-Disposition"]


def test_export_filters_prune_empty_categories(client):
    keep = make_category(client, name="Keep")
    empty = make_category(client, name="Empty")
    task = make_task(client, title="only this one", category_id=keep["id"])

    resp = client.get(f"/api/export?ids={task['id']}")
    text = resp.get_data(as_text=True)
    assert "Keep" in text
    assert "Empty" not in text


# ---- import: parse ------------------------------------------------------

def test_parse_markdown_extracts_status_priority_tag_and_due(client):
    md = "## Work\n- [ ] Ship it #release ⏫ 📅 2026-09-01\n"
    resp = client.post("/api/import/preview", json={"markdown": md})
    assert resp.status_code == 200
    items = resp.get_json()["items"]
    assert len(items) == 1
    item = items[0]
    assert item["title"] == "Ship it"
    assert item["priority"] == "high"
    assert item["due_date"] == "2026-09-01"
    assert item["tags"] == ["release"]
    assert item["category_path"] == ["Work"]
    assert item["include"] is True


def test_parse_markdown_flags_unchecked_bullets_as_excluded(client):
    md = "- a plain bullet, not a checkbox\n"
    resp = client.post("/api/import/preview", json={"markdown": md})
    item = resp.get_json()["items"][0]
    assert item["include"] is False
    assert any("not a checkbox" in w for w in item["warnings"])


def test_parse_markdown_reports_dropped_fields(client):
    md = "- [ ] recurring chore 🔁 every week\n"
    resp = client.post("/api/import/preview", json={"markdown": md})
    item = resp.get_json()["items"][0]
    assert any("recurrence" in w for w in item["warnings"])
    assert "🔁" not in item["title"]


def test_parse_markdown_flags_duplicates_against_existing_tasks(client):
    make_task(client, title="already here")
    md = "- [ ] already here\n"
    resp = client.post("/api/import/preview", json={"markdown": md})
    item = resp.get_json()["items"][0]
    assert item.get("duplicate") is True


def test_import_preview_requires_markdown(client):
    resp = client.post("/api/import/preview", json={})
    assert resp.status_code == 400


def test_import_preview_writes_nothing(client):
    client.post("/api/import/preview",
                json={"markdown": "- [ ] should not be saved\n"})
    tasks = client.get("/api/tasks").get_json()
    assert tasks == []


# ---- import: commit -------------------------------------------------------

def test_import_commit_creates_tasks_and_categories(client):
    resp = client.post("/api/import/commit", json={"items": [
        {"title": "new task", "priority": "high", "due_date": "2026-09-01",
         "category_path": ["Home", "Garage"], "tags": ["errand"]},
    ]})
    assert resp.status_code == 201
    body = resp.get_json()
    assert body["created"] == 1
    assert body["categories_created"] == ["Home", "Garage"]

    tasks = client.get("/api/tasks").get_json()
    assert tasks[0]["title"] == "new task"
    assert tasks[0]["category_id"] is not None
    assert [t["name"] for t in tasks[0]["tags"]] == ["errand"]


def test_import_commit_requires_a_title(client):
    resp = client.post("/api/import/commit",
                        json={"items": [{"notes": "no title field at all"}]})
    assert resp.status_code == 400
    assert "title is required" in resp.get_json()["error"]


def test_import_commit_rejects_blank_title(client):
    resp = client.post("/api/import/commit",
                        json={"items": [{"title": "  "}]})
    assert resp.status_code == 400
    assert "title cannot be empty" in resp.get_json()["error"]


def test_import_commit_skips_items_marked_excluded(client):
    resp = client.post("/api/import/commit", json={"items": [
        {"title": "keep me", "include": True},
        {"title": "skip me", "include": False},
    ]})
    assert resp.status_code == 201
    titles = {t["title"] for t in client.get("/api/tasks").get_json()}
    assert titles == {"keep me"}


def test_import_commit_is_all_or_nothing(client):
    resp = client.post("/api/import/commit", json={"items": [
        {"title": "valid one"},
        {"title": "  "},  # invalid: blank title
    ]})
    assert resp.status_code == 400
    assert client.get("/api/tasks").get_json() == []


def test_export_then_import_preview_is_lossless(client):
    make_task(client, title="round trip me", priority="high",
              due_date="2026-09-01", tags=["infra"], notes="keep me too")

    exported = client.get("/api/export").get_data(as_text=True)
    resp = client.post("/api/import/preview", json={"markdown": exported})
    items = resp.get_json()["items"]
    item = next(i for i in items if i["title"] == "round trip me")
    assert item["priority"] == "high"
    assert item["due_date"] == "2026-09-01"
    assert item["tags"] == ["infra"]
    assert item["notes"] == "keep me too"
    # only the "already exists" duplicate warning is expected, nothing dropped
    assert item["warnings"] == ["a task with this title already exists"]
