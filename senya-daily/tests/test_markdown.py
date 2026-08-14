"""The per-day markdown mirror.

Every write rewrites `NOTES_DIR/YYYY-MM-DD.md` so the journal drops into an
Obsidian vault. Scalar trackers become frontmatter; text trackers and the note
become the body.
"""
import os

from app import build_markdown, slugify, valid_date, yaml_scalar


# ---- helpers ---------------------------------------------------------------

def test_valid_date():
    assert valid_date("2026-05-01")
    assert not valid_date("2026-13-01")     # no month 13
    assert not valid_date("2026-02-30")     # not a real day
    assert not valid_date("2026-5-1")       # must be zero-padded
    assert not valid_date("")
    assert not valid_date(None)


def test_slugify_makes_yaml_safe_keys():
    assert slugify("Push ups") == "push_ups"
    assert slugify("Water (glasses)") == "water_glasses"
    assert slugify("  Mood!  ") == "mood"
    assert slugify("💪") == "field"          # nothing usable left


def test_yaml_scalar_per_type():
    assert yaml_scalar("check", "1") == "true"
    assert yaml_scalar("check", "0") == "false"
    assert yaml_scalar("number", "42") == "42"
    assert yaml_scalar("rating", "4") == "4"
    assert yaml_scalar("text", "plain") == '"plain"'


def test_yaml_scalar_escapes_quotes_and_backslashes():
    """An unescaped quote in a note would produce a file Obsidian can't parse."""
    assert yaml_scalar("text", 'say "hi"') == '"say \\"hi\\""'
    assert yaml_scalar("text", "back\\slash") == '"back\\\\slash"'


# ---- rendering -------------------------------------------------------------

def test_markdown_has_frontmatter_and_heading(client, make_tracker, db):
    t = make_tracker(name="Pushups", type="number", unit="reps")
    client.put("/api/days/2026-05-01", json={"entries": {str(t["id"]): "30"}})

    md = build_markdown(db, "2026-05-01")
    assert md.startswith("---\n")
    assert "date: 2026-05-01" in md
    assert "pushups: 30" in md
    assert "# 🗓️ 2026-05-01" in md


def test_note_text_lands_in_the_body(client, db):
    client.put("/api/days/2026-05-01", json={"note": "a quiet day"})
    assert "a quiet day" in build_markdown(db, "2026-05-01")


def test_text_trackers_become_their_own_sections(client, make_tracker, db):
    food = make_tracker(name="Food", type="text", icon="🍔")
    client.put("/api/days/2026-05-01", json={"entries": {str(food["id"]): "pasta"}})

    md = build_markdown(db, "2026-05-01")
    assert "## 🍔 Food" in md
    assert "pasta" in md
    assert "food:" not in md          # text is a section, not frontmatter


def test_check_and_rating_render_as_scalars(client, make_tracker, db):
    workout = make_tracker(name="Workout", type="check")
    mood = make_tracker(name="Mood", type="rating")
    client.put("/api/days/2026-05-01",
               json={"entries": {str(workout["id"]): "1", str(mood["id"]): "4"}})

    md = build_markdown(db, "2026-05-01")
    assert "workout: true" in md
    assert "mood: 4" in md


def test_colliding_slugs_do_not_overwrite_each_other(client, make_tracker, db):
    """"Push ups" and "Push-ups" both slugify to push_ups; both must survive."""
    a = make_tracker(name="Push ups", type="number")
    b = make_tracker(name="Push-ups", type="number")
    client.put("/api/days/2026-05-01",
               json={"entries": {str(a["id"]): "10", str(b["id"]): "20"}})

    frontmatter = build_markdown(db, "2026-05-01").split("---")[1]
    assert "10" in frontmatter and "20" in frontmatter
    keys = [ln.split(":")[0] for ln in frontmatter.strip().splitlines()]
    assert len(keys) == len(set(keys)), f"duplicate frontmatter keys: {keys}"


def test_empty_text_tracker_is_omitted(client, make_tracker, db):
    food = make_tracker(name="Food", type="text")
    client.put("/api/days/2026-05-01", json={"entries": {str(food["id"]): "   "}})
    assert "## Food" not in build_markdown(db, "2026-05-01")


# ---- the file on disk ------------------------------------------------------

def test_file_is_written_on_save(client, notes_dir):
    client.put("/api/days/2026-05-01", json={"note": "hello"})
    path = os.path.join(notes_dir, "2026-05-01.md")
    assert os.path.isfile(path)
    assert "hello" in open(path, encoding="utf-8").read()


def test_file_is_rewritten_on_every_change(client, notes_dir):
    client.put("/api/days/2026-05-01", json={"note": "first"})
    client.put("/api/days/2026-05-01", json={"note": "second"})
    content = open(os.path.join(notes_dir, "2026-05-01.md"), encoding="utf-8").read()
    assert "second" in content and "first" not in content


def test_file_is_deleted_when_the_day_is_emptied(client, notes_dir):
    """An empty day should leave no file behind, not an empty one."""
    path = os.path.join(notes_dir, "2026-05-01.md")
    client.put("/api/days/2026-05-01", json={"note": "temporary"})
    assert os.path.isfile(path)

    client.put("/api/days/2026-05-01", json={"note": ""})
    assert not os.path.exists(path)


def test_no_temp_file_is_left_behind(client, notes_dir):
    """The write is tmp+rename; a stray .tmp would sync into the vault."""
    client.put("/api/days/2026-05-01", json={"note": "hello"})
    assert os.listdir(notes_dir) == ["2026-05-01.md"]


def test_deleting_a_tracker_rewrites_the_affected_days(client, make_tracker, notes_dir):
    """Its values must leave the markdown too, not just the database."""
    t = make_tracker(name="Pushups", type="number")
    client.put("/api/days/2026-05-01", json={"note": "keep", "entries": {str(t["id"]): "30"}})
    assert "pushups: 30" in open(os.path.join(notes_dir, "2026-05-01.md")).read()

    client.delete(f"/api/trackers/{t['id']}")
    content = open(os.path.join(notes_dir, "2026-05-01.md")).read()
    assert "pushups" not in content
    assert "keep" in content          # the note itself survives
