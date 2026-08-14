"""Pure parsing helpers shared by every site adapter."""
from scraper.sites.base import clean, parse_cookies, parse_price


# ---- prices ----------------------------------------------------------------

def test_parses_a_plain_price():
    assert parse_price("C $854.05") == (854.05, "CAD")


def test_strips_thousands_separators():
    amount, _ = parse_price("C $1,234.56")
    assert amount == 1234.56


def test_a_range_has_no_single_price():
    """'C $10.00 to C $40.00' — picking an end would misreport it in sorting and
    invent price drops that never happened."""
    amount, _ = parse_price("C $10.00 to C $40.00")
    assert amount is None


def test_unparseable_text_is_none_not_zero():
    assert parse_price("Contact seller")[0] is None
    assert parse_price("")[0] is None
    assert parse_price(None)[0] is None


def test_currency_defaults_to_cad():
    assert parse_price("$25.00")[1] == "CAD"


def test_currency_hints_are_detected():
    """A US price sorted as if it were Canadian would be wrong by a third."""
    amount, currency = parse_price("US $25.00")
    assert amount == 25.00
    assert currency == "USD"


# ---- whitespace ------------------------------------------------------------

def test_clean_collapses_the_whitespace_nested_markup_produces():
    assert clean("  a   \n  b\t c ") == "a b c"
    assert clean("") == ""
    assert clean(None) == ""


# ---- cookies ---------------------------------------------------------------

def test_parses_a_cookie_header():
    assert parse_cookies("c_user=100; xs=abc; datr=xyz") == {
        "c_user": "100", "xs": "abc", "datr": "xyz"}


def test_parses_a_json_cookie_export():
    raw = '[{"name": "c_user", "value": "100"}, {"name": "xs", "value": "abc"}]'
    assert parse_cookies(raw) == {"c_user": "100", "xs": "abc"}


def test_cookie_values_containing_equals_survive():
    """Base64 cookie values end in '=' — splitting on every '=' would truncate them."""
    assert parse_cookies("token=abc==; other=1") == {"token": "abc==", "other": "1"}


def test_empty_cookie_input():
    assert parse_cookies("") == {}
    assert parse_cookies(None) == {}
