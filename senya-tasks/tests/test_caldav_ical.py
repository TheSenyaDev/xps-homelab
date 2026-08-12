"""Pure text-format tests for the iCalendar helpers in caldav.py — no network,
no database. build_vtodo / parse_vtodo is the format the whole sync protocol
rests on, so a round trip through it has to be exact.
"""
import caldav


def base_task(**overrides):
    task = {
        "id": 1,
        "title": "Rotate the Tailscale keys",
        "notes": "",
        "status": "todo",
        "priority": "medium",
        "due_date": None,
        "position": 3,
        "created_at": "2026-08-01 10:00:00",
        "updated_at": "2026-08-01 10:00:00",
        "completed_at": None,
    }
    task.update(overrides)
    return task


def test_round_trip_minimal_task():
    task = base_task()
    ical = caldav.build_vtodo(task, tags=[], uid="senya-abc")
    parsed = caldav.parse_vtodo(ical)

    assert parsed["uid"] == "senya-abc"
    assert parsed["title"] == task["title"]
    assert parsed["status"] == "todo"
    assert parsed["priority"] == "medium"
    assert parsed["due_date"] is None
    assert parsed["tags"] == []


def test_round_trip_full_task_with_tags_and_due_date():
    task = base_task(notes="line one\nline two", priority="high",
                      due_date="2026-09-01")
    ical = caldav.build_vtodo(task, tags=["infra", "security"], uid="senya-full")
    parsed = caldav.parse_vtodo(ical)

    assert parsed["notes"] == "line one\nline two"
    assert parsed["priority"] == "high"
    assert parsed["due_date"] == "2026-09-01"
    assert parsed["tags"] == ["infra", "security"]


def test_done_task_round_trips_completed_at():
    task = base_task(status="done", completed_at="2026-08-05 12:00:00")
    ical = caldav.build_vtodo(task, tags=[], uid="senya-done")
    parsed = caldav.parse_vtodo(ical)

    assert parsed["status"] == "done"
    assert parsed["completed_at"] == "2026-08-05 12:00:00"
    assert "PERCENT-COMPLETE:100" in ical


def test_blocked_status_survives_round_trip_via_x_prop():
    task = base_task(status="blocked")
    ical = caldav.build_vtodo(task, tags=[], uid="senya-blocked")
    assert "X-SENYA-STATUS:blocked" in ical

    parsed = caldav.parse_vtodo(ical)
    assert parsed["status"] == "blocked"


def test_parent_uid_round_trips_via_related_to():
    task = base_task()
    ical = caldav.build_vtodo(task, tags=[], uid="senya-child",
                              parent_uid="senya-parent")
    parsed = caldav.parse_vtodo(ical)
    assert parsed["parent_uid"] == "senya-parent"


def test_parse_vtodo_returns_none_for_non_vtodo_text():
    assert caldav.parse_vtodo("BEGIN:VCALENDAR\nEND:VCALENDAR\n") is None


def test_priority_buckets_map_both_directions():
    for priority in ("high", "medium", "low"):
        task = base_task(priority=priority)
        ical = caldav.build_vtodo(task, tags=[], uid="senya-p")
        assert caldav.parse_vtodo(ical)["priority"] == priority


def test_fold_wraps_long_lines_at_75_octets_and_unfold_reverses_it():
    line = "SUMMARY:" + ("x" * 200)
    folded = caldav.fold(line)
    assert "\r\n " in folded
    assert all(len(part.encode("utf-8")) <= 75 for part in folded.split("\r\n "))
    assert caldav.unfold(folded) == line


def test_ical_escape_and_unescape_round_trip():
    text = "a; b, c\\d\ne"
    assert caldav.ical_unescape(caldav.ical_escape(text)) == text


def test_sql_and_ical_stamp_conversions_round_trip():
    sql_time = "2026-08-09 00:12:00"
    stamp = caldav.sql_to_utc_stamp(sql_time)
    assert stamp == "20260809T001200Z"
    assert caldav.stamp_to_sql(stamp) == sql_time


def test_stamp_to_sql_handles_date_only_values():
    assert caldav.stamp_to_sql("20260809") == "2026-08-09 00:00:00"


def test_stamp_to_sql_returns_none_for_garbage():
    assert caldav.stamp_to_sql("not-a-stamp") is None
