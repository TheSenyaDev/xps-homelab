"""The app factory wires every blueprint and route.

app.py was split into the `tasks/` package, and the failure mode of that kind of
split is silent: a blueprint left out of `all_blueprints()` doesn't raise, it
just 404s at runtime. This asserts the public surface exists.
"""
import pytest

from tasks.api import all_blueprints


EXPECTED_ROUTES = [
    ("GET", "/api/meta"),
    ("GET", "/api/settings"),
    ("PUT", "/api/settings"),
    ("GET", "/api/categories"),
    ("POST", "/api/categories"),
    ("POST", "/api/categories/reorder"),
    ("GET", "/api/tags"),
    ("GET", "/api/tasks"),
    ("POST", "/api/tasks"),
    ("POST", "/api/tasks/reorder"),
    ("GET", "/api/export"),
    ("POST", "/api/import/preview"),
    ("POST", "/api/import/commit"),
    ("GET", "/api/caldav"),
    ("PUT", "/api/caldav/config"),
    ("POST", "/api/caldav/test"),
    ("POST", "/api/caldav/sync"),
]


@pytest.mark.parametrize("method,rule", EXPECTED_ROUTES)
def test_route_is_registered(client, method, rule):
    app = client.application
    matches = [r for r in app.url_map.iter_rules()
               if r.rule == rule and method in r.methods]
    assert matches, f"{method} {rule} is not registered"


def test_every_blueprint_is_mounted():
    app_blueprints = {bp.name for bp in all_blueprints()}
    assert app_blueprints == {
        "meta", "settings", "categories", "tags", "tasks",
        "export", "imports", "caldav_api",
    }


def test_blueprint_names_are_unique():
    """Two blueprints with one name means Flask silently keeps one."""
    names = [bp.name for bp in all_blueprints()]
    assert len(names) == len(set(names))


def test_the_frontend_is_served(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"SenyaTasks" in resp.data


def test_static_assets_are_served(client):
    assert client.get("/favicon.png").status_code == 200


def test_unknown_api_path_is_404_not_the_index(client):
    """The catch-all static route must not swallow a mistyped API call."""
    assert client.get("/api/nonexistent").status_code == 404
