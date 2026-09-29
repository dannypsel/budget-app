"""Transaction auto-classification tests: need/want + fixed/variable tags.

Covers the static category defaults in categorizer.py, the merchant_txn_tags
memory override, tag persistence alongside every verdict path in
ai_categorize/pipeline.py (rules > cache > Jev), and failure safety: tag
resolution never raises and a pre-migration DB (no tag columns) still gets
its verdicts. No network, no keys, no DB.
"""

import pytest

import categorizer  # noqa: E402
from ai_categorize.pipeline import run_ai_categorization  # noqa: E402
from categorizer import fill_txn_tags, resolve_txn_tags  # noqa: E402
from tests.fakes import FakeSupabase  # noqa: E402

USER = "user-1"
CATS = [
    ("cat-rent", "Rent"),
    ("cat-groceries", "Groceries"),
    ("cat-dining", "Dining"),
    ("cat-custom", "My Custom Cat"),
]


@pytest.fixture
def sb_ctx(monkeypatch):
    """Point categorizer.load_guess_context's internal get_supabase() at the
    FakeSupabase under test, so the deterministic rules layer runs for real."""
    fakes = {}

    def _install(sb):
        fakes["sb"] = sb
        monkeypatch.setattr(categorizer, "get_supabase", lambda: sb)
        return sb

    return _install


def _sb(**overrides):
    tables = {
        "profiles": [
            {"id": USER, "ai_enabled": True, "ai_provider": "jev", "ai_confidence_threshold": 0.7}
        ],
        "accounts": [{"id": "acct-1", "user_id": USER, "type": "depository"}],
        "categories": [
            {"id": cid, "user_id": USER, "name": name, "is_active": True} for cid, name in CATS
        ],
        "transactions": [],
        "category_rules": [],
        "merchant_categories": [],
        "merchant_txn_tags": [],
        "ai_category_cache": [],
    }
    tables.update(overrides)
    return FakeSupabase(tables)


def _txn(tid, merchant, amount=25.0, **kw):
    row = {
        "id": tid,
        "account_id": "acct-1",
        "date": "2026-09-20",
        "amount": amount,
        "merchant_name": merchant,
        "description": merchant,
        "plaid_category": None,
        "category_id": None,
        "pending": False,
    }
    row.update(kw)
    return row


# ── static category defaults ──────────────────────────────────────────


@pytest.mark.parametrize(
    ("category_name", "expected"),
    [
        ("Rent", ("need", "fixed")),
        ("mortgage", ("need", "fixed")),
        ("  MORTGAGE  ", ("need", "fixed")),
        ("Groceries", ("need", "variable")),
        ("utilities", ("need", "variable")),
        ("Insurance", ("need", "fixed")),
        ("Dining", ("want", "variable")),
        ("dining & drinks", ("want", "variable")),
        ("Restaurants", ("want", "variable")),
        ("eating out", ("want", "variable")),
        ("Subscriptions", ("want", "fixed")),
        ("Shopping", ("want", "variable")),
        # unknown categories -> nulls, no silent guessing
        ("My Custom Cat", (None, None)),
        ("Travel", (None, None)),
        ("", (None, None)),
        (None, (None, None)),
    ],
)
def test_category_default_mapping(category_name, expected):
    assert resolve_txn_tags(category_name, "some merchant", {}) == expected


# ── merchant memory overrides the category default ────────────────────


def test_merchant_memory_overrides_category_default():
    memory = {"whole foods": {"need_want": "want", "spend_pattern": "fixed"}}
    assert resolve_txn_tags("Groceries", "whole foods", memory) == ("want", "fixed")


def test_merchant_memory_partial_row_falls_back_to_default_per_field():
    memory = {"whole foods": {"need_want": "need", "spend_pattern": None}}
    assert resolve_txn_tags("Groceries", "whole foods", memory) == ("need", "variable")


def test_merchant_memory_applies_to_unknown_category():
    memory = {"landlord llc": {"need_want": "need", "spend_pattern": "fixed"}}
    assert resolve_txn_tags("My Custom Cat", "landlord llc", memory) == ("need", "fixed")


def test_merchant_memory_invalid_values_fall_back_to_default():
    memory = {"whole foods": {"need_want": "maybe", "spend_pattern": "sometimes"}}
    assert resolve_txn_tags("Groceries", "whole foods", memory) == ("need", "variable")


def test_resolve_never_raises_on_garbage():
    assert resolve_txn_tags(123, None, None) == (None, None)
    assert resolve_txn_tags("Groceries", "k", {"k": "not-a-dict"}) == ("need", "variable")
    assert resolve_txn_tags(None, None, {"k": None}) == (None, None)


# ── verdict application writes both tags (rules path) ─────────────────


def test_rules_verdict_writes_category_default_tags(sb_ctx):
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "WHOLE FOODS")],
            merchant_categories=[
                {"user_id": USER, "merchant_key": "whole foods", "category_id": "cat-groceries"}
            ],
        )
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["rules_applied"] == 1
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-groceries"
    assert txn["ai_source"] == "rules"
    assert txn["need_want"] == "need"
    assert txn["spend_pattern"] == "variable"


def test_rules_verdict_merchant_memory_overrides_default(sb_ctx):
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "WHOLE FOODS")],
            merchant_categories=[
                {"user_id": USER, "merchant_key": "whole foods", "category_id": "cat-groceries"}
            ],
            merchant_txn_tags=[
                {
                    "user_id": USER,
                    "merchant_key": "whole foods",
                    "need_want": "want",
                    "spend_pattern": "fixed",
                }
            ],
        )
    )
    run_ai_categorization(sb, USER)
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-groceries"
    assert txn["need_want"] == "want"  # merchant memory beat the category default
    assert txn["spend_pattern"] == "fixed"


def test_unknown_category_leaves_tags_null_but_verdict_applies(sb_ctx):
    # A rule points at a category id with no row in categories (deleted or
    # inactive): the verdict still applies, the tags stay null, nothing raises.
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "MYSTERY SHOP")],
            merchant_categories=[
                {"user_id": USER, "merchant_key": "mystery shop", "category_id": "cat-gone"}
            ],
        )
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["rules_applied"] == 1
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-gone"
    assert txn.get("need_want") is None
    assert txn.get("spend_pattern") is None


# ── verdict application writes both tags (cache + Jev paths) ──────────


def test_cache_verdict_writes_tags(monkeypatch, sb_ctx):
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "Chipotle")],
            ai_category_cache=[
                {
                    "user_id": USER,
                    "merchant_key": "chipotle",
                    "category_id": "cat-dining",
                    "confidence": 0.9,
                    "source": "jev",
                }
            ],
        )
    )
    called = []
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post", lambda *a, **k: called.append(1)
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["from_cache"] == 1
    assert called == []
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-dining"
    assert txn["ai_source"] == "cache:jev"
    assert txn["need_want"] == "want"
    assert txn["spend_pattern"] == "variable"


def test_jev_verdict_writes_tags(monkeypatch, sb_ctx):
    import json

    sb = sb_ctx(_sb(transactions=[_txn("t1", "Trader Joes")]))
    monkeypatch.setenv("JEV_API_KEY", "k")

    class _Resp:
        status_code = 200
        text = ""

        def __init__(self, payload):
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

        def raise_for_status(self):
            pass

    def fake_post(url, headers=None, json=None, timeout=None):
        return _Resp(
            {
                "answers": {
                    "txn_t1": {
                        "type": "choice",
                        "choice": "cat-groceries",
                        "probabilities": {"cat-groceries": 0.93},
                        "confidence": 0.93,
                    }
                }
            }
        )

    monkeypatch.setattr("ai_categorize.providers.requests.post", fake_post)
    stats = run_ai_categorization(sb, USER)
    assert stats["ai_applied"] == 1
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-groceries"
    assert txn["need_want"] == "need"
    assert txn["spend_pattern"] == "variable"


# ── failure safety ────────────────────────────────────────────────────


def test_missing_tag_columns_retry_persists_verdict_alone(sb_ctx):
    """Pre-migration DB: the tagged update 400s, the verdict-alone retry
    succeeds — the categorize step keeps working."""
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "WHOLE FOODS")],
            merchant_categories=[
                {"user_id": USER, "merchant_key": "whole foods", "category_id": "cat-groceries"}
            ],
        )
    )
    real_table = sb.table

    def table(name):
        q = real_table(name)
        if name == "transactions":
            real_execute = q.execute

            def execute():
                if q.op == "update" and "need_want" in (q.payload or {}):
                    raise RuntimeError("column need_want does not exist")
                return real_execute()

            q.execute = execute
        return q

    sb.table = table
    stats = run_ai_categorization(sb, USER)  # must not raise
    assert stats["rules_applied"] == 1
    assert stats["errors"] == 0
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-groceries"  # verdict persisted via retry
    assert txn.get("need_want") is None


def test_verdict_persist_failure_never_raises(sb_ctx):
    """Both the tagged write and the retry fail: logged + counted, never raised."""
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "WHOLE FOODS")],
            merchant_categories=[
                {"user_id": USER, "merchant_key": "whole foods", "category_id": "cat-groceries"}
            ],
        )
    )
    real_table = sb.table

    def table(name):
        q = real_table(name)
        if name == "transactions":
            real_execute = q.execute

            def execute():
                if q.op == "update":
                    # Verdict write AND the no-tags retry both fail: the call
                    # site logs and counts it; reads (selects) keep working.
                    raise RuntimeError("db down")
                return real_execute()

            q.execute = execute
        return q

    sb.table = table
    stats = run_ai_categorization(sb, USER)  # must not raise
    assert stats["errors"] == 1


# ── fill_txn_tags (sync/reconcile insert path) ─────────────────────────
# Rows categorized by apply_learned at insert time never enter the Jev
# pipeline, so sync.py/reconcile.py fill tags via categorizer.fill_txn_tags.


def _tag_ctx(**overrides):
    ctx = {
        "cat_names": {cid: name for cid, name in CATS},
        "tag_memory": {},
    }
    ctx.update(overrides)
    return ctx


def test_fill_tags_category_default():
    rows = [_txn("t1", "Landlord LLC", category_id="cat-rent")]
    out = fill_txn_tags(rows, _tag_ctx())
    assert out[0]["need_want"] == "need"
    assert out[0]["spend_pattern"] == "fixed"


def test_fill_tags_merchant_memory_overrides_default():
    ctx = _tag_ctx(tag_memory={"whole foods": {"need_want": "want", "spend_pattern": "variable"}})
    rows = [_txn("t1", "Whole Foods", category_id="cat-groceries")]
    out = fill_txn_tags(rows, ctx)
    assert out[0]["need_want"] == "want"
    assert out[0]["spend_pattern"] == "variable"


def test_fill_tags_skips_uncategorized_rows():
    rows = [_txn("t1", "Unknown Shop")]
    out = fill_txn_tags(rows, _tag_ctx())
    assert "need_want" not in out[0]
    assert "spend_pattern" not in out[0]


def test_fill_tags_unknown_category_adds_no_keys():
    rows = [_txn("t1", "Bespoke Store", category_id="cat-custom")]
    out = fill_txn_tags(rows, _tag_ctx())
    assert "need_want" not in out[0]
    assert "spend_pattern" not in out[0]


def test_fill_tags_preserves_existing_tags():
    rows = [_txn("t1", "Landlord LLC", category_id="cat-rent",
                 need_want="want", spend_pattern="variable")]
    out = fill_txn_tags(rows, _tag_ctx())
    assert out[0]["need_want"] == "want"
    assert out[0]["spend_pattern"] == "variable"


def test_fill_tags_never_raises_on_garbage():
    assert fill_txn_tags(None, None) is None
    sentinel = object()
    row = {"category_id": sentinel}
    assert fill_txn_tags([row], {}) == [row]
    rows = [_txn("t1", "Landlord LLC", category_id="cat-rent")]
    assert fill_txn_tags(rows, {"cat_names": None, "tag_memory": "junk"}) == rows
