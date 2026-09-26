"""AI categorization tests: provider contract, Jev wire format (mocked),
pipeline order (rules > cache > Jev > Brave-enrich > review), thresholds,
batching, provider swapping, cache behavior. No network, no keys, no DB.

Live Jev smoke test lives at the bottom and runs only with JEV_API_KEY set;
otherwise it skips with a clear message (never fails).
"""

import json
import os

import pytest

import categorizer  # noqa: E402
from ai_categorize.merchant_search import lookup_merchant  # noqa: E402
from ai_categorize.pipeline import run_ai_categorization  # noqa: E402
from ai_categorize.providers import (  # noqa: E402
    JevProvider,
    classify_concurrent,
    get_provider,
)
from tests.fakes import FakeSupabase

USER = "user-1"
CATS = [("cat-groceries", "Groceries"), ("cat-gas", "Gas"), ("cat-fun", "Fun")]


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


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _jev_answers(conf_by_tid, choice_by_tid=None):
    answers = {}
    for tid, conf in conf_by_tid.items():
        choice = (choice_by_tid or {}).get(tid, "cat-groceries")
        answers[f"txn_{tid}"] = {
            "type": "choice",
            "choice": choice,
            "probabilities": {choice: conf},
            "confidence": conf,
        }
    return {"answers": answers}


# ── provider factory: the one-line swap ───────────────────────────────


def test_get_provider_jev(monkeypatch):
    monkeypatch.setenv("JEV_API_KEY", "k")
    p = get_provider("jev")
    assert isinstance(p, JevProvider)


def test_get_provider_off_returns_none():
    assert get_provider("off") is None
    assert get_provider("") is None


def test_get_provider_unknown_raises():
    with pytest.raises(ValueError, match="unknown AI_CLASSIFIER_PROVIDER"):
        get_provider("Muse")


def test_get_provider_jev_needs_key(monkeypatch):
    monkeypatch.delenv("JEV_API_KEY", raising=False)
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="JEV_API_KEY"):
        get_provider("jev")


def test_gemini_is_clean_stub():
    with pytest.raises(NotImplementedError, match="stub"):
        get_provider("gemini")


# ── Jev wire format (mocked HTTP) ─────────────────────────────────────


def test_jev_request_shape(monkeypatch):
    seen = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen["url"] = url
        seen["headers"] = headers
        seen["json"] = json
        return _Resp(_jev_answers({"t1": 0.95}))

    monkeypatch.setattr("ai_categorize.providers.requests.post", fake_post)
    p = JevProvider(api_key="k", model="jev-latest")
    out = p.classify_batch([("t1", "state text", CATS)])

    assert seen["url"] == "https://api.typesafe.ai/v1/systemone"
    assert seen["headers"]["Authorization"] == "Bearer k"
    body = seen["json"]
    assert body["model"] == "jev-latest"
    q = body["questions"]["txn_t1"]
    assert q["type"] == "choice"
    # criteria keys ARE category ids — the winner comes back verbatim
    assert q["criteria"] == {cid: label for cid, label in CATS}
    assert body["state"]["transactions"][0]["id"] == "t1"

    assert out[0].category_id == "cat-groceries"
    assert out[0].confidence == pytest.approx(0.95)


def test_jev_rejects_invented_category(monkeypatch):
    def fake_post(url, headers=None, json=None, timeout=None):
        return _Resp(_jev_answers({"t1": 0.99}, {"t1": "cat-not-real"}))

    monkeypatch.setattr("ai_categorize.providers.requests.post", fake_post)
    out = JevProvider(api_key="k").classify_batch([("t1", "s", CATS)])
    assert out[0].category_id is None
    assert out[0].confidence == 0.0


def test_jev_batches_ten_per_call(monkeypatch):
    calls = []

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append(json)
        tids = [q.removeprefix("txn_") for q in json["questions"]]
        return _Resp(_jev_answers({t: 0.9 for t in tids}))

    monkeypatch.setattr("ai_categorize.providers.requests.post", fake_post)
    items = [(f"t{i}", "s", CATS) for i in range(25)]
    out = JevProvider(api_key="k").classify_batch(items)
    assert len(calls) == 3
    assert [len(c["questions"]) for c in calls] == [10, 10, 5]
    assert len(out) == 25
    assert all(c.confidence == 0.9 for c in out)


def test_jev_401_raises_clear_error(monkeypatch):
    def fake_post(url, headers=None, json=None, timeout=None):
        return _Resp({"error": "bad key"}, status=401)

    monkeypatch.setattr("ai_categorize.providers.requests.post", fake_post)
    with pytest.raises(RuntimeError, match="401"):
        JevProvider(api_key="bad").classify_batch([("t1", "s", CATS)])


def test_classify_concurrent_preserves_order_and_isolates_failures(monkeypatch):
    real = JevProvider.classify_batch

    def flaky(self, batch):
        if any(tid == "bad" for tid, _s, _c in batch):
            raise RuntimeError("boom")
        return real(self, batch)

    monkeypatch.setattr(JevProvider, "classify_batch", flaky)
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post",
        lambda url, headers=None, json=None, timeout=None: _Resp(
            _jev_answers({q.removeprefix("txn_"): 0.9 for q in json["questions"]})
        ),
    )
    p = JevProvider(api_key="k")
    items = [(f"t{i}", "s", CATS) for i in range(12)] + [("bad", "s", CATS)]
    out = classify_concurrent(p, items, workers=2)
    assert len(out) == 13
    assert all(c.confidence == 0.9 for c in out[:10])
    # the whole batch containing 'bad' comes back zero-confidence —
    # batch-level isolation, still ordered, still no raise
    assert all(c.category_id is None and c.confidence == 0.0 for c in out[10:])


# ── pipeline: rules always win ────────────────────────────────────────


def test_rules_beat_ai_no_api_call(monkeypatch, sb_ctx):
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "WHOLE FOODS")],
            merchant_categories=[
                {"user_id": USER, "merchant_key": "whole foods", "category_id": "cat-groceries"}
            ],
        )
    )
    called = []
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post", lambda *a, **k: called.append(1) or _Resp({})
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["rules_applied"] == 1
    assert stats["ai_applied"] == 0
    assert called == []
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-groceries"
    assert txn["ai_source"] == "rules"


# ── pipeline: cache hit skips the API ─────────────────────────────────


def test_cache_hit_skips_api(monkeypatch, sb_ctx):
    sb = sb_ctx(
        _sb(
            transactions=[_txn("t1", "Shell Oil")],
            ai_category_cache=[
                {
                    "user_id": USER,
                    "merchant_key": "shell oil",
                    "category_id": "cat-gas",
                    "confidence": 0.88,
                    "source": "jev",
                }
            ],
        )
    )
    called = []
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post", lambda *a, **k: called.append(1) or _Resp({})
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["from_cache"] == 1
    assert called == []
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-gas"
    assert txn["ai_source"] == "cache:jev"


# ── pipeline: happy path — classify, apply, cache ─────────────────────


def test_high_confidence_applies_and_caches(monkeypatch, sb_ctx):
    sb = sb_ctx(_sb(transactions=[_txn("t1", "Trader Joes")]))
    monkeypatch.setenv("JEV_API_KEY", "k")
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post",
        lambda url, headers=None, json=None, timeout=None: _Resp(
            _jev_answers({"t1": 0.93}, {"t1": "cat-groceries"})
        ),
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["ai_applied"] == 1
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-groceries"
    assert txn["ai_confidence"] == pytest.approx(0.93)
    assert txn["ai_source"] == "jev"
    cache = sb.tables["ai_category_cache"]
    assert len(cache) == 1
    assert cache[0]["merchant_key"] == "trader joes"
    assert cache[0]["category_id"] == "cat-groceries"


# ── pipeline: low confidence -> Brave enrich -> re-classify ────────────


def test_low_confidence_triggers_search_then_reclassify(monkeypatch, sb_ctx):
    sb = sb_ctx(_sb(transactions=[_txn("t1", "ZZZQ MART")]))
    monkeypatch.setenv("JEV_API_KEY", "k")
    monkeypatch.setenv("BRAVE_API_KEY", "b")

    posts = []

    def fake_post(url, headers=None, json=None, timeout=None):
        posts.append(json)
        state = json["state"]["transactions"][0]["detail"]
        if "Web lookup" in state:
            return _Resp(_jev_answers({"t1": 0.85}, {"t1": "cat-groceries"}))
        return _Resp(_jev_answers({"t1": 0.40}, {"t1": "cat-gas"}))

    monkeypatch.setattr("ai_categorize.providers.requests.post", fake_post)

    searches = []

    def fake_lookup(merchant, api_key=None, max_results=3):
        searches.append(merchant)
        return "ZZZQ MART: a regional grocery chain"

    monkeypatch.setattr("ai_categorize.pipeline.lookup_merchant", fake_lookup)

    stats = run_ai_categorization(sb, USER)
    assert searches == ["ZZZQ MART"]  # exactly one search
    assert len(posts) == 2  # initial classify + enriched re-classify
    assert stats["ai_applied"] == 1
    txn = sb.tables["transactions"][0]
    assert txn["category_id"] == "cat-groceries"  # enriched verdict won


def test_still_low_confidence_stays_uncategorized(monkeypatch, sb_ctx):
    sb = sb_ctx(_sb(transactions=[_txn("t1", "MYSTERY LLC")]))
    monkeypatch.setenv("JEV_API_KEY", "k")
    monkeypatch.setenv("BRAVE_API_KEY", "b")
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post",
        lambda url, headers=None, json=None, timeout=None: _Resp(
            _jev_answers({"t1": 0.30}, {"t1": "cat-fun"})
        ),
    )
    monkeypatch.setattr(
        "ai_categorize.pipeline.lookup_merchant",
        lambda merchant, api_key=None, max_results=3: "MYSTERY LLC: unknown",
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["needs_review"] == 1
    assert stats["ai_applied"] == 0
    assert sb.tables["transactions"][0]["category_id"] is None


def test_no_brave_key_skips_search_gracefully(monkeypatch, sb_ctx):
    sb = sb_ctx(_sb(transactions=[_txn("t1", "MYSTERY LLC")]))
    monkeypatch.setenv("JEV_API_KEY", "k")
    monkeypatch.delenv("BRAVE_API_KEY", raising=False)
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post",
        lambda url, headers=None, json=None, timeout=None: _Resp(_jev_answers({"t1": 0.30})),
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["needs_review"] == 1
    assert sb.tables["transactions"][0]["category_id"] is None


# ── pipeline: disabled / misconfigured never blows up ─────────────────


def test_disabled_profile_skips_everything(monkeypatch, sb_ctx):
    sb = sb_ctx(
        _sb(
            profiles=[
                {
                    "id": USER,
                    "ai_enabled": False,
                    "ai_provider": "jev",
                    "ai_confidence_threshold": 0.7,
                }
            ],
            transactions=[_txn("t1", "Trader Joes")],
        )
    )
    called = []
    monkeypatch.setattr(
        "ai_categorize.providers.requests.post", lambda *a, **k: called.append(1) or _Resp({})
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["status"] == "disabled"
    assert called == []


def test_provider_off_skips_everything(monkeypatch, sb_ctx):
    sb = sb_ctx(
        _sb(
            profiles=[
                {
                    "id": USER,
                    "ai_enabled": True,
                    "ai_provider": "off",
                    "ai_confidence_threshold": 0.7,
                }
            ],
            transactions=[_txn("t1", "Trader Joes")],
        )
    )
    stats = run_ai_categorization(sb, USER)
    assert stats["status"] == "disabled"


def test_pipeline_never_raises(monkeypatch, sb_ctx):
    sb = sb_ctx(_sb(transactions=[_txn("t1", "Trader Joes")]))
    monkeypatch.setenv("JEV_API_KEY", "k")

    def boom(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr("ai_categorize.providers.requests.post", boom)
    stats = run_ai_categorization(sb, USER)  # must not raise
    assert stats["needs_review"] == 1  # failed batch -> review, counted


# ── merchant search client ────────────────────────────────────────────


def test_lookup_merchant_request_shape(monkeypatch):
    seen = {}

    def fake_get(url, headers=None, params=None, timeout=None):
        seen.update(url=url, headers=headers, params=params)
        return _Resp(
            {
                "web": {
                    "results": [{"title": "Acme Grocers", "description": "A grocery store chain"}]
                }
            }
        )

    monkeypatch.setattr("ai_categorize.merchant_search.requests.get", fake_get)
    blurb = lookup_merchant("Acme", api_key="b")
    assert seen["url"] == "https://api.search.brave.com/res/v1/web/search"
    assert seen["headers"]["X-Subscription-Token"] == "b"
    assert "Acme" in seen["params"]["q"]
    assert blurb == "Acme Grocers: A grocery store chain"


def test_lookup_merchant_never_raises(monkeypatch):
    monkeypatch.setattr(
        "ai_categorize.merchant_search.requests.get",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")),
    )
    assert lookup_merchant("Acme", api_key="b") is None
    assert lookup_merchant("Acme", api_key=None) is None


# ── live smoke test: real Jev API, only with a key ────────────────────


@pytest.mark.skipif(
    not os.environ.get("JEV_API_KEY") and not os.environ.get("TYPESAFE_API_KEY"),
    reason="no JEV_API_KEY (or TYPESAFE_API_KEY) in env — live Jev smoke test "
    "skipped. Set JEV_API_KEY to run it.",
)
def test_jev_live_smoke():
    """Hit the real Jev API with 4 well-known merchants. Costs a fraction of
    a cent. Requires JEV_API_KEY (or TYPESAFE_API_KEY) in the environment."""
    cats = [
        ("live-groceries", "Groceries — supermarkets, food stores"),
        ("live-gas", "Gas — fuel stations"),
        ("live-streaming", "Streaming — subscriptions like Netflix"),
        ("live-travel", "Travel — airlines, hotels"),
    ]
    items = [
        (
            "m1",
            "Merchant: Whole Foods Market\nDescription: WHOLE FOODS MKT\n"
            "Amount: $84.12 money out (purchase)",
            cats,
        ),
        (
            "m2",
            "Merchant: Shell\nDescription: SHELL OIL 5744\nAmount: $52.00 money out (purchase)",
            cats,
        ),
        (
            "m3",
            "Merchant: Netflix\nDescription: NETFLIX.COM\nAmount: $15.49 money out (purchase)",
            cats,
        ),
        (
            "m4",
            "Merchant: Delta Air Lines\nDescription: DELTA AIR 0062\n"
            "Amount: $312.40 money out (purchase)",
            cats,
        ),
    ]
    expected = {
        "m1": "live-groceries",
        "m2": "live-gas",
        "m3": "live-streaming",
        "m4": "live-travel",
    }
    out = JevProvider().classify_batch(items)
    assert len(out) == 4
    for (_tid, _s, _c), verdict in zip(items, out, strict=True):
        assert isinstance(verdict.confidence, float)
        assert 0.0 <= verdict.confidence <= 1.0
        assert verdict.category_id in {c[0] for c in cats} | {None}
    hits = sum(
        1 for (tid, _s, _c), v in zip(items, out, strict=True) if v.category_id == expected[tid]
    )
    assert hits >= 3, f"only {hits}/4 live classifications matched expected"
