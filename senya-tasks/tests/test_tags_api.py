from helpers import make_task


def test_posting_unknown_tag_names_creates_them(client):
    make_task(client, title="x", tags=["Errand"])
    tags = client.get("/api/tags").get_json()
    assert any(t["name"] == "errand" for t in tags)


def test_tag_task_count(client):
    make_task(client, title="a", tags=["shared"])
    make_task(client, title="b", tags=["shared"])
    make_task(client, title="c", tags=["solo"])

    tags = {t["name"]: t["task_count"] for t in client.get("/api/tags").get_json()}
    assert tags["shared"] == 2
    assert tags["solo"] == 1


def test_updating_tags_on_a_task_replaces_the_set(client):
    task = make_task(client, title="x", tags=["a", "b"])
    resp = client.patch(f"/api/tasks/{task['id']}", json={"tags": ["c"]})
    names = sorted(t["name"] for t in resp.get_json()["tags"])
    assert names == ["c"]


def test_rename_tag_normalises_the_name(client):
    make_task(client, title="x", tags=["old"])
    tag_id = next(t["id"] for t in client.get("/api/tags").get_json()
                  if t["name"] == "old")

    resp = client.patch(f"/api/tags/{tag_id}", json={"name": "New Name"})
    assert resp.get_json()["name"] == "new-name"


def test_delete_tag_removes_label_but_keeps_task(client):
    task = make_task(client, title="x", tags=["temp"])
    tag_id = next(t["id"] for t in client.get("/api/tags").get_json())

    resp = client.delete(f"/api/tags/{tag_id}")
    assert resp.status_code == 204

    tags = client.get("/api/tags").get_json()
    assert tags == []

    tasks = client.get(f"/api/tasks?ids={task['id']}").get_json()
    assert tasks[0]["title"] == "x"
