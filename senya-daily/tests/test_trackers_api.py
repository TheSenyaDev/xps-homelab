"""Trackers: the user-defined fields every day is logged against."""


def test_create_tracker_defaults(client):
    t = client.post("/api/trackers", json={"name": "Pushups"}).get_json()
    assert t["name"] == "Pushups"
    assert t["type"] == "number"          # the default type
    assert t["archived"] == 0
    assert t["calendar"] == 1             # shown on the calendar unless told otherwise
    assert t["color"] == "#6366f1"


def test_create_tracker_requires_a_name(client):
    assert client.post("/api/trackers", json={}).status_code == 400
    assert client.post("/api/trackers", json={"name": "   "}).status_code == 400


def test_create_tracker_accepts_every_supported_type(client):
    for typ in ("number", "text", "check", "rating"):
        t = client.post("/api/trackers", json={"name": f"T {typ}", "type": typ}).get_json()
        assert t["type"] == typ


def test_unknown_type_falls_back_to_number(client):
    """An unrecognised type is corrected rather than rejected — the field still works."""
    t = client.post("/api/trackers", json={"name": "Odd", "type": "colour"}).get_json()
    assert t["type"] == "number"


def test_new_trackers_go_to_the_end(client):
    a = client.post("/api/trackers", json={"name": "A"}).get_json()
    b = client.post("/api/trackers", json={"name": "B"}).get_json()
    assert b["position"] > a["position"]


def test_calendar_flag_can_be_turned_off_at_creation(client):
    t = client.post("/api/trackers", json={"name": "Private", "calendar": False}).get_json()
    assert t["calendar"] == 0


def test_list_is_ordered_by_position(client):
    for name in ("First", "Second", "Third"):
        client.post("/api/trackers", json={"name": name})
    names = [t["name"] for t in client.get("/api/trackers").get_json()]
    assert names == ["First", "Second", "Third"]


# ---- update ----------------------------------------------------------------

def test_update_tracker_fields(client, make_tracker):
    t = make_tracker()
    updated = client.patch(f"/api/trackers/{t['id']}",
                           json={"name": "Push-ups", "unit": "sets", "color": "#000000"}).get_json()
    assert updated["name"] == "Push-ups"
    assert updated["unit"] == "sets"
    assert updated["color"] == "#000000"


def test_update_rejects_a_blank_name(client, make_tracker):
    t = make_tracker()
    assert client.patch(f"/api/trackers/{t['id']}", json={"name": "  "}).status_code == 400


def test_update_with_no_known_fields_is_rejected(client, make_tracker):
    t = make_tracker()
    assert client.patch(f"/api/trackers/{t['id']}", json={"nonsense": 1}).status_code == 400


def test_update_missing_tracker_is_404(client):
    assert client.patch("/api/trackers/9999", json={"name": "Ghost"}).status_code == 404


def test_archiving_hides_a_tracker_from_the_default_list(client, make_tracker):
    t = make_tracker(name="Old habit")
    client.patch(f"/api/trackers/{t['id']}", json={"archived": True})

    assert client.get("/api/trackers").get_json() == []
    assert len(client.get("/api/trackers?archived=1").get_json()) == 1


# ---- delete ----------------------------------------------------------------

def test_delete_tracker_removes_it(client, make_tracker):
    t = make_tracker()
    assert client.delete(f"/api/trackers/{t['id']}").status_code == 204
    assert client.get("/api/trackers").get_json() == []


def test_delete_tracker_cascades_to_its_entries(client, make_tracker, db):
    t = make_tracker()
    client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): "20"}})
    assert db.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 1

    client.delete(f"/api/trackers/{t['id']}")
    assert db.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 0
