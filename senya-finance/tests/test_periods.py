"""Month arithmetic behind the budget pace marker and the month-over-month
comparisons. Small functions, but every one of them is wrong at a boundary if
written carelessly — and a wrong month silently compares against the wrong data
rather than failing.
"""
import calendar
from datetime import date
from unittest.mock import patch

from finance.api.budgets import _month_progress
from finance.api.insights import _pct_change, _shift_month


# ---- month shifting --------------------------------------------------------

def test_shift_month_within_a_year():
    assert _shift_month("2026-05", -1) == "2026-04"
    assert _shift_month("2026-05", 1) == "2026-06"


def test_shift_month_across_the_year_boundary():
    assert _shift_month("2026-01", -1) == "2025-12"
    assert _shift_month("2025-12", 1) == "2026-01"


def test_shift_month_by_a_full_year():
    assert _shift_month("2026-07", -12) == "2025-07"
    assert _shift_month("2026-07", -18) == "2025-01"


# ---- month progress --------------------------------------------------------

def _progress(month, today):
    with patch("finance.api.budgets.date") as d:
        d.today.return_value = today
        return _month_progress(month)


def test_progress_partway_through_the_current_month():
    assert _progress("2026-05", date(2026, 5, 12)) == (12, 31)


def test_a_finished_month_counts_as_fully_elapsed():
    """Otherwise every past month reads as permanently under budget."""
    assert _progress("2026-04", date(2026, 5, 12)) == (30, 30)


def test_a_future_month_has_not_started():
    assert _progress("2026-06", date(2026, 5, 12)) == (0, 30)


def test_progress_uses_the_real_length_of_february():
    assert _progress("2024-02", date(2024, 2, 10)) == (10, 29)   # leap year
    assert _progress("2026-02", date(2026, 2, 10)) == (10, 28)


def test_month_progress_matches_the_calendar_for_every_month():
    for m in range(1, 13):
        _, days = _progress(f"2026-{m:02d}", date(2026, 6, 15))
        assert days == calendar.monthrange(2026, m)[1]


# ---- percent change --------------------------------------------------------

def test_pct_change_reports_direction_and_size():
    assert _pct_change(150, 100) == 50.0
    assert _pct_change(50, 100) == -50.0


def test_pct_change_is_none_without_a_baseline():
    """No previous spend means there is no percentage — not a division by zero,
    and not a misleading "+100%"."""
    assert _pct_change(150, 0) is None
    assert _pct_change(150, None) is None
