"""Recurring-charge detection.

The detector decides what counts as a subscription from spacing and amount
alone, so these pin down the edges: what must be caught, what must *not* be
(irregular shopping), and the two judgement calls that are easy to get wrong —
which date "now" is measured from, and when a price rise is real.
"""
from datetime import date, timedelta

from finance.recurring import as_of_date, detect, normalize_merchant, summarize


def tx(day, merchant, amount, direction="out"):
    return {"date": day, "merchant": merchant, "amount": amount, "direction": direction}


def monthly_series(merchant="NETFLIX", amount=16.99, n=6, start="2026-01-05"):
    """n charges roughly a month apart, with the day-of-month drift real bills have."""
    d0 = date.fromisoformat(start)
    out = []
    for i in range(n):
        d = d0 + timedelta(days=round(30.4 * i)) + timedelta(days=(i % 3) - 1)
        out.append(tx(d.isoformat(), merchant, amount))
    return out


# ---- what must be detected -------------------------------------------------

def test_detects_a_monthly_subscription():
    series = detect(monthly_series())
    assert len(series) == 1
    s = series[0]
    assert s["cadence"] == "monthly"
    assert s["typical_amount"] == 16.99
    assert s["occurrences"] == 6


def test_detects_weekly_biweekly_and_yearly():
    for label, step in [("weekly", 7), ("biweekly", 14), ("yearly", 365)]:
        d0 = date(2024, 1, 3)
        txs = [tx((d0 + timedelta(days=step * i)).isoformat(), f"THING {label}", 20.0)
               for i in range(5)]
        series = detect(txs)
        assert series and series[0]["cadence"] == label, f"{label} not detected"


def test_monthly_equivalent_normalizes_cadence():
    """A weekly charge should read as more per month than its sticker price."""
    d0 = date(2026, 1, 1)
    txs = [tx((d0 + timedelta(days=7 * i)).isoformat(), "GYM", 10.0) for i in range(6)]
    s = detect(txs)[0]
    assert s["monthly_equivalent"] > 40    # ~4.3 charges a month
    # Both are rounded from the same unrounded rate, so they agree to the cent
    # rather than exactly (yearly is not the rounded monthly times twelve).
    assert abs(s["yearly_equivalent"] - s["monthly_equivalent"] * 12) < 0.05


# ---- what must NOT be detected --------------------------------------------

def test_ignores_irregular_spending():
    """Shopping at the same place a lot is not a subscription."""
    days = ["2026-01-03", "2026-01-04", "2026-01-19", "2026-02-27", "2026-03-01", "2026-05-14"]
    assert detect([tx(d, "GROCERY STORE", 40.0) for d in days]) == []


def test_ignores_money_coming_in():
    txs = [tx(t["date"], "PAYROLL", 2000.0, direction="in") for t in monthly_series()]
    assert detect(txs) == []


def test_needs_at_least_three_charges():
    assert detect(monthly_series(n=2)) == []


def test_one_off_amount_does_not_break_the_series():
    """A single big charge from a subscription merchant is excluded from the median."""
    txs = monthly_series(amount=16.99, n=6)
    txs.append(tx("2026-03-15", "NETFLIX", 400.00))   # not the subscription
    s = detect(txs)[0]
    assert s["typical_amount"] == 16.99


# ---- "now" is the last import, not today ----------------------------------

def test_as_of_date_is_the_newest_transaction():
    txs = monthly_series(n=3, start="2026-01-05")
    newest = max(t["date"] for t in txs)
    assert as_of_date(txs) == date.fromisoformat(newest)
    assert as_of_date([]) == date.today()   # nothing imported yet


def test_active_is_judged_against_the_data_not_the_clock():
    """Stale imports must not make every subscription look cancelled."""
    txs = monthly_series(n=6, start="2020-01-05")     # long in the past
    assert detect(txs)[0]["active"] is True


def test_a_genuinely_stopped_subscription_is_inactive():
    txs = monthly_series(n=6, start="2026-01-05")
    # Ask about it a year after the last charge, with the clock held still.
    last = date.fromisoformat(txs[-1]["date"])
    assert detect(txs, today=last + timedelta(days=365))[0]["active"] is False


def test_next_due_follows_the_last_charge():
    txs = monthly_series(n=6, start="2026-01-05")
    s = detect(txs)[0]
    assert s["next_due"] > s["last_seen"]


# ---- price changes ---------------------------------------------------------

def test_flags_a_price_increase():
    txs = monthly_series(amount=9.99, n=6)
    txs[-1]["amount"] = 12.99                          # the hike
    s = detect(txs)[0]
    assert s["price_change"] is not None
    assert s["price_change"]["from"] == 9.99
    assert s["price_change"]["to"] == 12.99
    assert s["price_change"]["percent"] > 25


def test_does_not_flag_a_steady_price():
    assert detect(monthly_series(amount=9.99, n=6))[0]["price_change"] is None


def test_does_not_flag_a_trivial_rounding_difference():
    txs = monthly_series(amount=20.00, n=6)
    txs[-1]["amount"] = 20.10                          # 0.5%, noise not a hike
    assert detect(txs)[0]["price_change"] is None


# ---- merchant normalization ------------------------------------------------

def test_normalize_strips_per_transaction_noise():
    a = normalize_merchant("Internet Banking INTERNET BILL PAY 000000114258 VISA")
    b = normalize_merchant("Internet Banking INTERNET BILL PAY 000000228343 VISA")
    assert a == b


def test_normalize_strips_store_numbers():
    assert normalize_merchant("LCBO/RAO #0623") == normalize_merchant("LCBO/RAO #751")


def test_normalization_groups_a_series_that_would_otherwise_be_missed():
    """Reference numbers differ every month; without stripping them this is 6 one-offs."""
    txs = [{**t, "merchant": f"PREAUTHORIZED DEBIT {100000 + i * 137} INSURANCE"}
           for i, t in enumerate(monthly_series(n=6))]
    assert len(detect(txs)) == 1


# ---- summary ---------------------------------------------------------------

def test_summary_totals_only_count_active_series():
    active = monthly_series(merchant="ACTIVE ONE", amount=10.0, n=6, start="2026-01-05")
    stopped = monthly_series(merchant="STOPPED ONE", amount=99.0, n=6, start="2020-01-05")
    series = detect(active + stopped)

    summary = summarize(series)
    assert summary["active_count"] == 1
    assert summary["inactive_count"] == 1
    # The $99 one stopped years ago and must not inflate the monthly total.
    assert summary["monthly_total"] < 20
