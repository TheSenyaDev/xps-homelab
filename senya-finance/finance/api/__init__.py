"""API blueprints. Register a new feature by adding a module here exposing a
`bp` Blueprint and listing it in `all_blueprints()`."""
from .budgets import bp as budgets_bp
from .categories import bp as categories_bp
from .imports import bp as imports_bp
from .insights import bp as insights_bp
from .merchants import bp as merchants_bp
from .recurring import bp as recurring_bp
from .rules import bp as rules_bp
from .summary import bp as summary_bp
from .transactions import bp as transactions_bp
from .trends import bp as trends_bp


def all_blueprints():
    return [transactions_bp, categories_bp, rules_bp, summary_bp, imports_bp,
            recurring_bp, trends_bp, budgets_bp, insights_bp, merchants_bp]
