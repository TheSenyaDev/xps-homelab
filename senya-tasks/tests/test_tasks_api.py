from helpers import error_of, make_category, make_task


def test_create_task_minimal_defaults(client):
    task = make_task(client, title="Buy milk")
    assert task["title"] == "Buy milk"
    assert task["status"] == "todo"
    assert task["priority"] == "medium"
    assert task["done"] is False
    assert task["tags"] == []
    assert task["category_id"] is None


def test_create_task_requires_title_key(client):
    resp = client.post("/api/tasks", json={"notes": "no title field at all"})
    assert resp.status_code == 400
    assert error_of(resp) == "title is required"


def test_create_task_rejects_blank_title(client):
    resp = client.post("/api/tasks", json={"title": "   "})
    assert resp.status_code == 400
    assert error_of(resp) == "title cannot be empty"


def test_title_is_trimmed_and_capped(client):
    task = make_task(client, title="  padded  ")
    assert task["title"] == "padded"

    task = make_task(client, title="x" * 600)
    assert len(task["title"]) == 500


def test_create_task_rejects_bad_status(client):
    resp = client.post("/api/tasks", json={"title": "x", "status": "yolo"})
    assert resp.status_code == 400
    assert "status must be one of" in error_of(resp)


def test_create_task_with_tags(client):
    task = make_task(client, title="Tagged", tags=["Errand", "waiting "])
    names = sorted(t["name"] for t in task["tags"])
    assert names == ["errand", "waiting"]


def test_create_task_tags_must_be_a_list(client):
    resp = client.post("/api/tasks", json={"title": "x", "tags": "not-a-list"})
    assert resp.status_code == 400
    assert "tags must be a list" in error_of(resp)


def test_done_shortcut_maps_to_status(client):
    task = make_task(client, title="x", done=True)
    assert task["status"] == "done"
    assert task["done"] is True


def test_update_task_status_to_done_stamps_completed_at(client):
    task = make_task(client, title="finish me")
    assert task["completed_at"] is None

    resp = client.patch(f"/api/tasks/{task['id']}", json={"status": "done"})
    assert resp.status_code == 200
    updated = resp.get_json()
    assert updated["status"] == "done"
    assert updated["completed_at"] is not None

    # moving back off done clears it again
    resp = client.patch(f"/api/tasks/{task['id']}", json={"status": "todo"})
    assert resp.get_json()["completed_at"] is None


def test_update_task_updated_at_bumps_on_write(client, db):
    task = make_task(client, title="x")
    before = db.execute("SELECT updated_at FROM tasks WHERE id = ?",
                         (task["id"],)).fetchone()["updated_at"]

    client.patch(f"/api/tasks/{task['id']}", json={"notes": "changed"})
    after = db.execute("SELECT updated_at FROM tasks WHERE id = ?",
                        (task["id"],)).fetchone()["updated_at"]
    assert after >= before


def test_update_task_not_found(client):
    resp = client.patch("/api/tasks/999999", json={"title": "ghost"})
    assert resp.status_code == 404


def test_update_task_with_nothing_to_update(client):
    task = make_task(client, title="x")
    resp = client.patch(f"/api/tasks/{task['id']}", json={})
    assert resp.status_code == 400
    assert error_of(resp) == "nothing to update"


def test_delete_task(client):
    task = make_task(client, title="doomed")
    resp = client.delete(f"/api/tasks/{task['id']}")
    assert resp.status_code == 204

    remaining = client.get("/api/tasks").get_json()
    assert all(t["id"] != task["id"] for t in remaining)


def test_reorder_tasks_writes_positions_in_order(client):
    a = make_task(client, title="a")
    b = make_task(client, title="b")
    c = make_task(client, title="c")

    resp = client.post("/api/tasks/reorder",
                        json={"ids": [c["id"], a["id"], b["id"]]})
    assert resp.status_code == 204

    listed = client.get("/api/tasks").get_json()
    order = [t["id"] for t in listed if t["id"] in (a["id"], b["id"], c["id"])]
    assert order == [c["id"], a["id"], b["id"]]


def test_reorder_requires_a_list(client):
    resp = client.post("/api/tasks/reorder", json={"ids": "nope"})
    assert resp.status_code == 400


# ---- filters ----------------------------------------------------------

def test_filter_by_status(client):
    make_task(client, title="open one")
    make_task(client, title="closed one", status="done")

    open_only = client.get("/api/tasks?status=todo").get_json()
    assert {t["title"] for t in open_only} == {"open one"}


def test_filter_by_category(client):
    cat = make_category(client, name="Work")
    make_task(client, title="in category", category_id=cat["id"])
    make_task(client, title="uncategorized")

    in_cat = client.get(f"/api/tasks?category_id={cat['id']}").get_json()
    assert [t["title"] for t in in_cat] == ["in category"]

    none_cat = client.get("/api/tasks?category_id=none").get_json()
    assert [t["title"] for t in none_cat] == ["uncategorized"]


def test_filter_by_search_text(client):
    make_task(client, title="fix the leaky faucet")
    make_task(client, title="unrelated task", notes="mentions faucet too")
    make_task(client, title="something else")

    hits = client.get("/api/tasks?q=faucet").get_json()
    assert {t["title"] for t in hits} == {"fix the leaky faucet", "unrelated task"}


def test_filter_by_tag(client):
    make_task(client, title="tagged", tags=["urgent"])
    make_task(client, title="untagged")

    hits = client.get("/api/tasks?tag=urgent").get_json()
    assert [t["title"] for t in hits] == ["tagged"]


def test_filter_by_due_before(client):
    make_task(client, title="overdue", due_date="2026-01-01")
    make_task(client, title="future", due_date="2099-01-01")
    make_task(client, title="undated")

    hits = client.get("/api/tasks?due_before=2026-06-01").get_json()
    assert [t["title"] for t in hits] == ["overdue"]


def test_filter_by_explicit_ids(client):
    a = make_task(client, title="a")
    make_task(client, title="b")

    hits = client.get(f"/api/tasks?ids={a['id']}").get_json()
    assert [t["id"] for t in hits] == [a["id"]]

    empty = client.get("/api/tasks?ids=").get_json()
    assert empty == []


def test_due_date_validation(client):
    resp = client.post("/api/tasks", json={"title": "x", "due_date": "not-a-date"})
    assert resp.status_code == 400
    assert "due_date must be YYYY-MM-DD" in error_of(resp)

    resp = client.post("/api/tasks", json={"title": "x", "due_date": "2024-02-30"})
    assert resp.status_code == 400
    assert "not a real date" in error_of(resp)


def test_category_id_must_exist(client):
    resp = client.post("/api/tasks", json={"title": "x", "category_id": 999999})
    assert resp.status_code == 400
    assert error_of(resp) == "category not found"


# ---- subtasks -----------------------------------------------------------

def test_subtask_creation_and_one_level_limit(client):
    parent = make_task(client, title="parent")
    child = make_task(client, title="child", parent_id=parent["id"])
    assert child["parent_id"] == parent["id"]

    resp = client.post("/api/tasks",
                        json={"title": "grandchild", "parent_id": child["id"]})
    assert resp.status_code == 400
    assert "cannot have subtasks" in error_of(resp)


def test_a_task_cannot_be_its_own_parent(client):
    task = make_task(client, title="x")
    resp = client.patch(f"/api/tasks/{task['id']}", json={"parent_id": task["id"]})
    assert resp.status_code == 400
    assert error_of(resp) == "a task cannot be its own parent"


def test_a_task_with_subtasks_cannot_become_one(client):
    parent = make_task(client, title="parent")
    make_task(client, title="child", parent_id=parent["id"])
    other = make_task(client, title="other top-level task")

    resp = client.patch(f"/api/tasks/{parent['id']}",
                         json={"parent_id": other["id"]})
    assert resp.status_code == 400
    assert "this task has subtasks" in error_of(resp)


def test_parent_id_null_promotes_to_top_level(client):
    parent = make_task(client, title="parent")
    child = make_task(client, title="child", parent_id=parent["id"])

    resp = client.patch(f"/api/tasks/{child['id']}", json={"parent_id": None})
    assert resp.get_json()["parent_id"] is None


def test_deleting_a_parent_cascades_to_children(client, db):
    parent = make_task(client, title="parent")
    child = make_task(client, title="child", parent_id=parent["id"])

    client.delete(f"/api/tasks/{parent['id']}")

    row = db.execute("SELECT * FROM tasks WHERE id = ?", (child["id"],)).fetchone()
    assert row is None
