"""Reading, writing, creating and deleting notes."""
import os


# ---- read ------------------------------------------------------------------

def test_read_returns_content_and_mtime(client, write_note):
    write_note("hello.md", "# Hello\n\nbody\n")
    body = client.get("/api/file?path=hello.md").get_json()
    assert body["content"] == "# Hello\n\nbody\n"
    assert body["path"] == "hello.md"
    assert body["mtime"] > 0


def test_read_missing_note_is_404(client):
    assert client.get("/api/file?path=nope.md").status_code == 404


def test_read_non_markdown_is_refused(client, write_note):
    write_note("config.yaml", "secret: value")
    resp = client.get("/api/file?path=config.yaml")
    assert resp.status_code == 400
    assert "markdown" in resp.get_json()["error"]


def test_read_survives_invalid_utf8(client, vault):
    """A byte the bridge wrote badly shouldn't 500 the reader."""
    with open(os.path.join(vault, "broken.md"), "wb") as f:
        f.write(b"caf\xe9 broken\n")
    resp = client.get("/api/file?path=broken.md")
    assert resp.status_code == 200
    assert "broken" in resp.get_json()["content"]


# ---- write -----------------------------------------------------------------

def test_write_creates_and_updates(client, vault):
    assert client.put("/api/file", json={"path": "n.md", "content": "one"}).status_code == 200
    assert open(os.path.join(vault, "n.md")).read() == "one"

    client.put("/api/file", json={"path": "n.md", "content": "two"})
    assert open(os.path.join(vault, "n.md")).read() == "two"


def test_write_creates_missing_folders(client, vault):
    client.put("/api/file", json={"path": "a/b/c.md", "content": "deep"})
    assert os.path.isfile(os.path.join(vault, "a", "b", "c.md"))


def test_write_requires_string_content(client):
    assert client.put("/api/file", json={"path": "n.md"}).status_code == 400
    assert client.put("/api/file", json={"path": "n.md", "content": 42}).status_code == 400
    # An empty string is valid: clearing a note is not the same as omitting it.
    assert client.put("/api/file", json={"path": "n.md", "content": ""}).status_code == 200


def test_write_leaves_no_temp_file_behind(client, vault):
    """The write is tmp+rename; a leftover .tmp would show up in the bridge."""
    client.put("/api/file", json={"path": "n.md", "content": "x"})
    assert os.listdir(vault) == ["n.md"]


def test_write_refuses_non_markdown(client):
    assert client.put("/api/file", json={"path": "x.txt", "content": "x"}).status_code == 400


# ---- create ----------------------------------------------------------------

def test_create_makes_an_empty_note(client, vault):
    resp = client.post("/api/file", json={"path": "fresh.md"})
    assert resp.status_code == 201
    assert open(os.path.join(vault, "fresh.md")).read() == ""


def test_create_appends_the_extension(client, vault):
    resp = client.post("/api/file", json={"path": "no-extension"})
    assert resp.status_code == 201
    assert resp.get_json()["path"] == "no-extension.md"
    assert os.path.isfile(os.path.join(vault, "no-extension.md"))


def test_create_refuses_to_clobber(client, write_note):
    write_note("taken.md", "precious")
    assert client.post("/api/file", json={"path": "taken.md"}).status_code == 409


def test_create_does_not_truncate_the_existing_note(client, write_note, vault):
    write_note("taken.md", "precious")
    client.post("/api/file", json={"path": "taken.md"})
    assert open(os.path.join(vault, "taken.md")).read() == "precious"


# ---- delete ----------------------------------------------------------------

def test_delete_removes_the_file(client, write_note, vault):
    write_note("bye.md")
    assert client.delete("/api/file?path=bye.md").status_code == 204
    assert not os.path.exists(os.path.join(vault, "bye.md"))


def test_delete_is_idempotent(client):
    """Deleting what's already gone is success, not an error."""
    assert client.delete("/api/file?path=ghost.md").status_code == 204


def test_delete_refuses_non_markdown(client, write_note, vault):
    write_note("keep.yaml", "data")
    assert client.delete("/api/file?path=keep.yaml").status_code == 400
    assert os.path.exists(os.path.join(vault, "keep.yaml"))
