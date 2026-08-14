"""Days: the note plus one value per tracker, and the calendar summary."""


# ---- reading ---------------------------------------------------------------

def test_get_an_empty_day(client):
    day = client.get("/api/days/2026-05-01").get_json()
    assert day == {"date": "2026-05-01", "note": "", "entries": {}}


def test_bad_date_is_rejected(client):
    for bad in ("not-a-date", "2026-13-01", "2026-02-30", "26-05-01", "2026-5-1"):
        assert client.get(f"/api/days/{bad}").status_code == 400, bad
        assert client.put(f"/api/days/{bad}", json={"note": "x"}).status_code == 400, bad


# ---- writing ---------------------------------------------------------------

def test_put_saves_a_note(client):
    body = client.put("/api/days/2026-05-01", json={"note": "a good day"}).get_json()
    assert body["note"] == "a good day"
    assert client.get("/api/days/2026-05-01").get_json()["note"] == "a good day"


def test_blank_note_clears_the_day(client, db):
    client.put("/api/days/2026-05-01", json={"note": "temporary"})
    client.put("/api/days/2026-05-01", json={"note": "   "})

    assert client.get("/api/days/2026-05-01").get_json()["note"] == ""
    # Cleared, not stored as whitespace — otherwise the day counts as "has data".
    assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0


def test_put_saves_entries_keyed_by_tracker(client, make_tracker):
    t = make_tracker()
    body = client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): "30"}}).get_json()
    assert body["entries"] == {str(t["id"]): "30"}


def test_entries_are_upserted_not_duplicated(client, make_tracker, db):
    t = make_tracker()
    client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): "10"}})
    client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): "20"}})

    assert db.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 1
    assert client.get("/api/days/2026-05-01").get_json()["entries"][str(t["id"])] == "20"


def test_empty_value_deletes_the_entry(client, make_tracker):
    t = make_tracker()
    client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): "10"}})
    client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): ""}})
    assert client.get("/api/days/2026-05-01").get_json()["entries"] == {}


def test_unknown_tracker_id_is_skipped_not_a_crash(client):
    """A stale tracker id from an open tab must not 500 on the foreign key."""
    resp = client.put("/api/days/2026-05-01", json={"entries": {"9999": "5"}})
    assert resp.status_code == 200
    assert resp.get_json()["entries"] == {}


def test_non_numeric_tracker_key_is_skipped(client):
    resp = client.put("/api/days/2026-05-01", json={"entries": {"abc": "5"}})
    assert resp.status_code == 200


def test_note_and_entries_can_be_written_together(client, make_tracker):
    t = make_tracker()
    body = client.put("/api/days/2026-05-01",
                      json={"note": "leg day", "entries": {str(t["id"]): "50"}}).get_json()
    assert body["note"] == "leg day"
    assert body["entries"][str(t["id"])] == "50"


def test_writing_one_field_leaves_the_other_alone(client, make_tracker):
    t = make_tracker()
    client.put("/api/days/2026-05-01", json={"note": "keep me", "entries": {str(t["id"]): "5"}})
    client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): "6"}})

    day = client.get("/api/days/2026-05-01").get_json()
    assert day["note"] == "keep me"
    assert day["entries"][str(t["id"])] == "6"


# ---- calendar --------------------------------------------------------------

def test_calendar_reports_days_with_notes_and_trackers(client, make_tracker):
    t = make_tracker()
    client.put("/api/days/2026-05-04", json={"note": "wrote something"})
    client.put("/api/days/2026-05-05", json={"entries": {str(t["id"]): "12"}})

    cal = client.get("/api/calendar?year=2026&month=5").get_json()
    assert cal["year"] == 2026 and cal["month"] == 5
    days = cal["days"]
    assert days["2026-05-04"]["note"] is True
    # Each logged tracker carries its value, so the calendar can show numbers.
    assert days["2026-05-05"]["trackers"] == [{"id": t["id"], "value": "12"}]
    assert days["2026-05-05"]["entries"] == 1


def test_calendar_only_covers_the_month_asked_for(client):
    client.put("/api/days/2026-05-31", json={"note": "may"})
    client.put("/api/days/2026-06-01", json={"note": "june"})

    days = client.get("/api/calendar?year=2026&month=5").get_json()["days"]
    assert "2026-05-31" in days
    assert "2026-06-01" not in days


def test_calendar_omits_trackers_flagged_off_the_calendar(client, make_tracker):
    shown = make_tracker(name="Shown")
    hidden = make_tracker(name="Hidden", calendar=False)
    client.put("/api/days/2026-05-06",
               json={"entries": {str(shown["id"]): "1", str(hidden["id"]): "1"}})

    day = client.get("/api/calendar?year=2026&month=5").get_json()["days"]["2026-05-06"]
    assert [t["id"] for t in day["trackers"]] == [shown["id"]]
    # `entries` counts what the calendar shows, so the hidden one is absent from
    # both — the day does not advertise a tracker it won't draw.
    assert day["entries"] == 1


def test_calendar_rejects_bad_year_or_month(client):
    assert client.get("/api/calendar?year=abc").status_code == 400
    assert client.get("/api/calendar?month=abc").status_code == 400
    assert client.get("/api/calendar?year=2026&month=13").status_code == 400
    assert client.get("/api/calendar?year=2026&month=0").status_code == 400


def test_calendar_defaults_to_the_current_month(client):
    assert client.get("/api/calendar").status_code == 200
