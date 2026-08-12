"""Small request helpers shared across test modules."""


def make_task(client, **overrides):
    body = {"title": "Untitled task"}
    body.update(overrides)
    resp = client.post("/api/tasks", json=body)
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()


def make_category(client, name="Category", **overrides):
    body = {"name": name}
    body.update(overrides)
    resp = client.post("/api/categories", json=body)
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()


def error_of(resp):
    return resp.get_json()["error"]
