"""What counts as spending, in one place.

Every aggregation has to agree on this or two screens will report different
totals for the same month. Kept as SQL fragments rather than a Python filter so
the database still does the grouping.

Spending is money **out** that is either uncategorized or in an *expense*
category. Transfers are excluded on purpose: paying a credit card from chequing
moves money you already counted when the card was charged, so counting the
payment as well would double every dollar that passes through the card.
"""

# Requires the joins in JOIN below (aliases `t` and `c`).
IS_SPENDING = "t.direction = 'out' AND (t.category_id IS NULL OR c.kind = 'expense')"
IS_INCOME = "t.direction = 'in' AND c.kind = 'income'"
JOIN = "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id"
