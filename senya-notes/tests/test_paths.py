"""Path sandboxing.

This app takes a client-supplied path and turns it into a file on disk, so
`safe_abs` is the single thing standing between the API and the rest of the
filesystem. These are the cases that matter more than any feature test.
"""
import os

import app as app_module
from app import is_md, safe_abs


# ---- what must be refused --------------------------------------------------

def test_rejects_parent_directory_traversal():
    assert safe_abs("../../../etc/passwd") is None
    assert safe_abs("notes/../../../etc/passwd") is None


def test_rejects_null_bytes():
    assert safe_abs("note\x00.md") is None


def test_rejects_empty_path():
    assert safe_abs("") is None
    assert safe_abs(None) is None


def test_absolute_paths_are_forced_back_inside_the_vault(vault):
    """A leading slash is stripped, not honoured — /etc/passwd is vault/etc/passwd."""
    resolved = safe_abs("/etc/passwd")
    assert resolved is not None
    assert resolved.startswith(vault + os.sep)


def test_rejects_a_symlink_pointing_out_of_the_vault(vault, tmp_path):
    """The parent is resolved with realpath, so a symlinked directory can't escape."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.md").write_text("secret")
    os.symlink(str(outside), os.path.join(vault, "escape"))

    assert safe_abs("escape/secret.md") is None


# ---- what must be allowed --------------------------------------------------

def test_allows_a_plain_note():
    assert safe_abs("note.md") is not None


def test_allows_a_nested_note():
    resolved = safe_abs("folder/sub/note.md")
    assert resolved is not None and resolved.endswith(os.path.join("folder", "sub", "note.md"))


def test_allows_a_file_that_does_not_exist_yet(vault):
    """New notes must resolve — the guard checks the parent, not the file."""
    assert safe_abs("brand-new.md") == os.path.join(vault, "brand-new.md")


def test_is_md_is_case_insensitive():
    assert is_md("a.md") and is_md("A.MD") and is_md("Mixed.Md")
    assert not is_md("a.markdown") and not is_md("a.txt") and not is_md("a")


# ---- the guard is actually wired into every endpoint ----------------------

def test_every_file_endpoint_refuses_traversal(client):
    """A guard that one handler forgets to call is not a guard."""
    bad = "../../../etc/passwd.md"     # .md so it gets past the extension check
    assert client.get(f"/api/file?path={bad}").status_code == 400
    assert client.put("/api/file", json={"path": bad, "content": "x"}).status_code == 400
    assert client.post("/api/file", json={"path": bad}).status_code == 400
    assert client.delete(f"/api/file?path={bad}").status_code == 400


def test_traversal_does_not_write_outside_the_vault(client, tmp_path):
    target = tmp_path / "victim.md"
    target.write_text("original")
    # A path that would land on the file if the guard were missing.
    rel = os.path.relpath(str(target), app_module.VAULT_DIR)
    client.put("/api/file", json={"path": rel, "content": "overwritten"})
    assert target.read_text() == "original"
