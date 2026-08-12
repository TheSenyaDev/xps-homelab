import app as app_module
from helpers import make_task


def test_settings_defaults(client):
    body = client.get("/api/settings").get_json()
    assert body["values"]["completed_shown"] == 3
    keys = {s["key"] for s in body["schema"]}
    assert "completed_shown" in keys


def test_settings_write_clamps_to_bounds(client):
    resp = client.put("/api/settings", json={"completed_shown": 999})
    assert resp.get_json()["values"]["completed_shown"] == 25  # max

    resp = client.put("/api/settings", json={"completed_shown": -5})
    assert resp.get_json()["values"]["completed_shown"] == 0  # min


def test_settings_write_rejects_non_integer(client):
    resp = client.put("/api/settings", json={"completed_shown": "lots"})
    assert resp.status_code == 400
    assert "whole number" in resp.get_json()["error"]


def test_settings_write_ignores_unknown_keys(client):
    resp = client.put("/api/settings", json={"nonsense_key": "whatever"})
    assert resp.status_code == 200
    assert "nonsense_key" not in resp.get_json()["values"]


def test_settings_persist_across_requests(client):
    client.put("/api/settings", json={"completed_shown": 7})
    body = client.get("/api/settings").get_json()
    assert body["values"]["completed_shown"] == 7


def test_meta_reports_vocabularies_and_counts(client):
    make_task(client, title="a")
    make_task(client, title="b", status="done")

    meta = client.get("/api/meta").get_json()
    assert meta["statuses"] == ["todo", "doing", "blocked", "done"]
    assert meta["priorities"] == ["high", "medium", "low"]
    assert meta["counts"]["todo"] == 1
    assert meta["counts"]["done"] == 1
    assert meta["schema_version"] == app_module.SCHEMA_VERSION
    assert meta["markdown_path"]
