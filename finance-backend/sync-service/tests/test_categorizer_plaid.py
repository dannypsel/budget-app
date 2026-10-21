"""Plaid-first classification order (Daniel's rule, 2026-09-30):
bank-provided Plaid PFC (detailed → primary) → merchant memory → keyword
rules → income by sign. Transfer signals never map to a category."""

from categorizer import apply_learned, plaid_category_name

CTX = {
    "memory": {"starbucks": "cat-dining"},
    "rules": [{"keyword": "starbucks", "category_id": "cat-shopping"}],
    "income_id": "cat-income",
    "cat_ids_by_name": {
        "Groceries": "cat-groceries",
        "Dining & Drinks": "cat-dining",
        "Auto & Transport": "cat-auto",
        "Rent": "cat-rent",
        "Utilities": "cat-utilities",
        "Travel": "cat-travel",
        "Income": "cat-income",
    },
}


def test_plaid_detail_beats_memory_and_rules():
    txns = [{
        "merchant_name": "Starbucks", "description": "", "amount": 6.0,
        "plaid_category": "FOOD_AND_DRINK",
        "plaid_category_detail": "FOOD_AND_DRINK_GROCERIES",
    }]
    apply_learned(txns, CTX)
    assert txns[0]["category_id"] == "cat-groceries"


def test_plaid_primary_used_when_no_detail_match():
    txns = [{
        "merchant_name": "Some Airline", "description": "", "amount": 300.0,
        "plaid_category": "TRAVEL", "plaid_category_detail": "TRAVEL_FLIGHTS",
    }]
    apply_learned(txns, CTX)
    assert txns[0]["category_id"] == "cat-travel"


def test_memory_wins_when_plaid_unmapped():
    txns = [{
        "merchant_name": "Starbucks", "description": "", "amount": 6.0,
        "plaid_category": "GENERAL_MERCHANDISE",
        "plaid_category_detail": "GENERAL_MERCHANDISE_SUPERSTORES",
    }]
    apply_learned(txns, CTX)
    assert txns[0]["category_id"] == "cat-dining"


def test_transfer_signals_never_map():
    txns = [
        {"merchant_name": "Transfer In", "description": "", "amount": -500.0,
         "plaid_category": "TRANSFER_IN"},
        {"merchant_name": "Card Payment", "description": "", "amount": -500.0,
         "plaid_category": "LOAN_PAYMENTS"},
    ]
    apply_learned(txns, CTX)
    assert txns[0].get("category_id") is None
    assert txns[1].get("category_id") is None
    assert plaid_category_name({"plaid_category": "TRANSFER_OUT"}) is None


def test_card_refund_never_stamped_income_by_plaid():
    txns = [{
        "account_id": "card-1", "merchant_name": "Statement Credit",
        "description": "", "amount": -25.0, "plaid_category": "INCOME",
    }]
    apply_learned(txns, CTX, {"card-1": "credit"})
    assert txns[0].get("category_id") is None
    assert txns[0].get("is_reimbursement") is True


def test_plaid_income_for_money_in():
    txns = [{
        "merchant_name": "Employer", "description": "", "amount": -4200.0,
        "plaid_category": "INCOME",
        "plaid_category_detail": "INCOME_WAGES",
    }]
    apply_learned(txns, CTX)
    assert txns[0]["category_id"] == "cat-income"


# ── Simplifi subcategories first, top-level parent as fallback ──────────────

def test_plaid_detail_prefers_simplifi_subcategory():
    ctx = {**CTX, "cat_ids_by_name": {**CTX["cat_ids_by_name"],
                                      "Restaurants": "cat-restaurants", "Gas & Fuel": "cat-gas"}}
    txns = [
        {"merchant_name": "Doordash", "description": "", "amount": 31.0,
         "plaid_category": "FOOD_AND_DRINK", "plaid_category_detail": "FOOD_AND_DRINK_RESTAURANT"},
        {"merchant_name": "Shell", "description": "", "amount": 40.0,
         "plaid_category": "TRANSPORTATION", "plaid_category_detail": "TRANSPORTATION_GAS"},
        {"merchant_name": "Blue Bottle", "description": "", "amount": 6.0,
         "plaid_category": "FOOD_AND_DRINK", "plaid_category_detail": "FOOD_AND_DRINK_COFFEE"},
    ]
    apply_learned(txns, ctx)
    assert [t["category_id"] for t in txns] == ["cat-restaurants", "cat-gas", "cat-dining"]


def test_plaid_income_maps_to_personal_income():
    ctx = {**CTX, "cat_ids_by_name": {"Personal Income": "cat-personal-income"}}
    txns = [{"merchant_name": "Employer", "description": "", "amount": -3000.0,
             "plaid_category": "INCOME", "plaid_category_detail": "INCOME_WAGES"}]
    apply_learned(txns, ctx)
    assert txns[0]["category_id"] == "cat-personal-income"


def test_plaid_category_name_returns_most_specific_candidate():
    assert plaid_category_name({"plaid_category": "FOOD_AND_DRINK",
                                "plaid_category_detail": "FOOD_AND_DRINK_FAST_FOOD"}) == "Fast Food"
