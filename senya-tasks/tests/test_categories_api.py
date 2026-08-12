from helpers import error_of, make_category, make_task


def test_create_category_defaults(client):
    cat = make_category(client, name="Homelab")
    assert cat["name"] == "Homelab"
    assert cat["parent_id"] is None
    assert cat["color"] == "#6366f1"


def test_create_category_requires_name(client):
    resp = client.post("/api/categories", json={})
    assert resp.status_code == 400
    assert error_of(resp) == "name is required"


def test_duplicate_name_under_same_parent_is_rejected(client):
    make_category(client, name="Work")
    resp = client.post("/api/categories", json={"name": "Work"})
    assert resp.status_code == 409
    assert "already exists" in error_of(resp)


def test_same_name_allowed_under_different_parents(client):
    a = make_category(client, name="Parent A")
    b = make_category(client, name="Parent B")
    make_category(client, name="Network", parent_id=a["id"])
    same_name = make_category(client, name="Network", parent_id=b["id"])
    assert same_name["parent_id"] == b["id"]


def test_create_subcategory_with_missing_parent(client):
    resp = client.post("/api/categories", json={"name": "x", "parent_id": 999999})
    assert resp.status_code == 400
    assert error_of(resp) == "parent category not found"


def test_update_category_name_and_color(client):
    cat = make_category(client, name="Old name")
    resp = client.patch(f"/api/categories/{cat['id']}",
                         json={"name": "New name", "color": "#ff0000"})
    body = resp.get_json()
    assert body["name"] == "New name"
    assert body["color"] == "#ff0000"


def test_category_cannot_be_its_own_parent(client):
    cat = make_category(client, name="x")
    resp = client.patch(f"/api/categories/{cat['id']}",
                         json={"parent_id": cat["id"]})
    assert resp.status_code == 400
    assert "own parent" in error_of(resp)


def test_reparenting_into_own_subtree_is_rejected(client):
    parent = make_category(client, name="Parent")
    child = make_category(client, name="Child", parent_id=parent["id"])

    resp = client.patch(f"/api/categories/{parent['id']}",
                         json={"parent_id": child["id"]})
    assert resp.status_code == 400
    assert "nest a category inside its own subtree" in error_of(resp)


def test_update_missing_category(client):
    resp = client.patch("/api/categories/999999", json={"name": "x"})
    assert resp.status_code == 404


def test_reorder_categories(client):
    a = make_category(client, name="a")
    b = make_category(client, name="b")

    resp = client.post("/api/categories/reorder", json={"items": [
        {"id": a["id"], "position": 2},
        {"id": b["id"], "position": 1},
    ]})
    assert resp.status_code == 200
    ordered = [c["id"] for c in resp.get_json() if c["id"] in (a["id"], b["id"])]
    assert ordered == [b["id"], a["id"]]


def test_reorder_rejects_unknown_category(client):
    resp = client.post("/api/categories/reorder",
                        json={"items": [{"id": 999999, "position": 1}]})
    assert resp.status_code == 400


def test_delete_category_cascades_and_orphans_tasks(client, db):
    parent = make_category(client, name="Parent")
    child = make_category(client, name="Child", parent_id=parent["id"])
    task = make_task(client, title="in the child category", category_id=child["id"])

    resp = client.delete(f"/api/categories/{parent['id']}")
    assert resp.status_code == 204

    assert db.execute("SELECT * FROM categories WHERE id = ?",
                       (child["id"],)).fetchone() is None

    row = db.execute("SELECT category_id FROM tasks WHERE id = ?",
                      (task["id"],)).fetchone()
    assert row["category_id"] is None
