"""Malformed input must be a 400 with a reason, never a 500.

A 500 tells the caller nothing about which parameter was wrong, and fills the
log with a traceback for what is really just a typo in a query string. These
pin the contract for the parameters that get parsed rather than passed through.
"""
import pytest

from helpers import make_category, make_task


# ---- query-string filters --------------------------------------------------

@pytest.mark.parametrize("query", [
    "category_id=abc",
    "category_id=1.5",
    "ids=a,b,c",
    "ids=1,not-a-number",
    "status=nonsense",
    "priority=urgent",
    "due_before=not-a-date",
    "due_before=2026-13-45",
])
def test_bad_filters_are_rejected_with_a_message(client, query):
    resp = client.get(f"/api/tasks?{query}")
    assert resp.status_code == 400, f"{query} should be a 400, got {resp.status_code}"
    assert resp.get_json()["error"]


@pytest.mark.parametrize("query", [
    "category_id=",           # explicit "uncategorized"
    "category_id=none",
    "ids=",                   # empty selection, not "everything"
    "status=todo",
    "priority=high",
    "due_before=2026-05-01",
    "q=anything",
    "tag=errand",
])
def test_valid_filters_are_accepted(client, query):
    assert client.get(f"/api/tasks?{query}").status_code == 200


def test_an_empty_id_list_matches_nothing_rather_than_everything(client):
    """"Export what's selected" with nothing selected must not export the lot."""
    make_task(client, title="not selected")
    assert client.get("/api/tasks?ids=").get_json() == []


def test_the_same_validation_applies_to_the_export(client):
    """The export shares task_filters, so it must reject the same input."""
    assert client.get("/api/export?ids=a,b,c").status_code == 400
    assert client.get("/api/export?category_id=abc").status_code == 400


# ---- body payloads ---------------------------------------------------------

def test_reorder_rejects_non_numeric_ids(client):
    assert client.post("/api/tasks/reorder", json={"ids": ["a", "b"]}).status_code == 400


def test_reorder_rejects_a_non_list(client):
    assert client.post("/api/tasks/reorder", json={"ids": "1,2,3"}).status_code == 400


def test_category_reorder_rejects_a_bad_position(client):
    cat = make_category(client, name="Home")
    resp = client.post("/api/categories/reorder",
                       json={"items": [{"id": cat["id"], "position": "first"}]})
    assert resp.status_code == 400


def test_malformed_json_body_is_a_client_error(client):
    resp = client.post("/api/tasks", data="{not json", content_type="application/json")
    assert resp.status_code == 400


# ---- error shape -----------------------------------------------------------

def test_errors_are_json_with_an_error_key(client):
    """The frontend reads `error` off every failure; an HTML error page breaks it."""
    resp = client.get("/api/tasks?status=nonsense")
    assert resp.content_type.startswith("application/json")
    assert "error" in resp.get_json()


def test_not_found_uses_the_same_shape(client):
    resp = client.patch("/api/tasks/999999", json={"title": "ghost"})
    assert resp.status_code == 404
    assert "error" in resp.get_json()
