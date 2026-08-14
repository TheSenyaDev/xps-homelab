"""The vault tree and the health/sync signal."""
import os

import app as app_module


# ---- tree ------------------------------------------------------------------

def test_tree_lists_notes(client, write_note):
    write_note("a.md")
    write_note("b.md")
    names = [n["name"] for n in client.get("/api/tree").get_json()["tree"]]
    assert names == ["a.md", "b.md"]


def test_tree_nests_folders_and_puts_them_first(client, write_note):
    write_note("zzz.md")
    write_note("folder/inner.md")
    tree = client.get("/api/tree").get_json()["tree"]

    assert [n["type"] for n in tree] == ["dir", "file"]      # folders lead
    folder = tree[0]
    assert folder["name"] == "folder"
    assert folder["children"][0]["path"] == "folder/inner.md"


def test_tree_sorts_case_insensitively(client, write_note):
    for name in ("beta.md", "Alpha.md", "gamma.md"):
        write_note(name)
    names = [n["name"] for n in client.get("/api/tree").get_json()["tree"]]
    assert names == ["Alpha.md", "beta.md", "gamma.md"]


def test_tree_hides_dotfiles_and_dot_directories(client, write_note):
    write_note(".hidden.md")
    write_note(".obsidian/workspace.md")
    write_note("visible.md")
    names = [n["name"] for n in client.get("/api/tree").get_json()["tree"]]
    assert names == ["visible.md"]


def test_tree_omits_non_markdown_and_empty_folders(client, write_note, vault):
    write_note("real.md")
    write_note("attachments/photo.png", "binary-ish")
    os.makedirs(os.path.join(vault, "empty"), exist_ok=True)
    names = [n["name"] for n in client.get("/api/tree").get_json()["tree"]]
    assert names == ["real.md"]


def test_tree_of_an_empty_vault_is_empty_not_an_error(client):
    body = client.get("/api/tree").get_json()
    assert body["tree"] == []
    assert body["vault"]


# ---- vault status ----------------------------------------------------------

def test_vault_status_counts_notes_recursively(write_note):
    write_note("a.md")
    write_note("deep/b.md")
    write_note("deep/deeper/c.md")
    status = app_module.vault_status()
    assert status["notes"] == 3
    assert status["exists"] is True
    assert status["last_modified"] > 0


def test_vault_status_ignores_hidden_directories(write_note):
    write_note("real.md")
    write_note(".trash/deleted.md")
    assert app_module.vault_status()["notes"] == 1


def test_vault_status_on_an_empty_vault():
    status = app_module.vault_status()
    assert status["notes"] == 0
    assert status["last_modified"] is None


# ---- health ----------------------------------------------------------------
#
# The three states exist to tell "the sync chain is broken" apart from "nothing
# has synced yet", so each one is pinned rather than just the happy path.

def _stub_couch(monkeypatch, reachable):
    monkeypatch.setattr(app_module, "couch_status",
                        lambda: {"reachable": reachable, "doc_count": 5 if reachable else None,
                                 "db": "obsidian", "error": None if reachable else "URLError"})


def test_health_ok_when_backend_and_files_both_present(client, write_note, monkeypatch):
    write_note("a.md")
    _stub_couch(monkeypatch, True)
    assert client.get("/api/health").get_json()["status"] == "ok"


def test_health_warns_when_couch_is_up_but_nothing_synced(client, monkeypatch):
    _stub_couch(monkeypatch, True)
    assert client.get("/api/health").get_json()["status"] == "warn"


def test_health_warns_when_serving_files_with_couch_down(client, write_note, monkeypatch):
    """Cached notes still readable while CouchDB is unreachable is degraded, not dead."""
    write_note("a.md")
    _stub_couch(monkeypatch, False)
    assert client.get("/api/health").get_json()["status"] == "warn"


def test_health_errors_when_neither_side_is_healthy(client, monkeypatch):
    _stub_couch(monkeypatch, False)
    body = client.get("/api/health").get_json()
    assert body["status"] == "error"
    assert body["couchdb"]["reachable"] is False


def test_couch_status_reports_unreachable_rather_than_raising(monkeypatch):
    """A dead backend must degrade the health payload, not 500 the endpoint."""
    monkeypatch.setattr(app_module, "COUCHDB_URL", "http://127.0.0.1:1")
    status = app_module.couch_status()
    assert status["reachable"] is False
    assert status["error"]
