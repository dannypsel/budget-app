"""AI categorization pipeline.

Order (rules always win — deterministic, free, user-taught):
  1. categorizer.apply_learned on the candidate dicts (merchant memory +
     conditional keyword rules + income-by-sign). Only category_id fills are
     persisted — user-owned flags (is_reimbursement) are left alone.
  2. ai_category_cache lookup by normalized merchant key (repeat merchants
     never re-call the model).
  3. Jev (or the configured provider) Choice-classifies the remainder over
     the user's live active category list, batched.
  4. confidence < threshold -> Brave Search merchant lookup -> ONE re-classify
     with the enriched state.
  5. still < threshold -> left uncategorized (existing review queue).

Entry points: _finalize_user in sync.py (after every Plaid sync),
POST /categorize/auto in api.py (CSV import + on-demand button).

Never raises: every failure is logged and counted in stats, so a dead API
key or a flaky network can never break sync or import.
"""
import logging
import os
import time

from ai_categorize.merchant_search import lookup_merchant
from ai_categorize.providers import (
    classify_concurrent,
    get_provider,
)
from categorizer import _merchant_key, apply_learned, load_guess_context
from envutil import _env_float, _env_int

logger = logging.getLogger(__name__)

AI_MAX_TXNS_PER_RUN = _env_int("AI_MAX_TXNS_PER_RUN", 200)
# Brave merchant enrichment is sequential (one HTTP call per transaction) with
# a 15s default timeout — unbounded, this is the one part of the pipeline
# that can blow the 15-min Lambda cap (200 x 15s ≈ 50 min). Cap it per run and
# put an overall time budget around the whole run; transactions that don't get
# enrichment simply fall through to the review queue (never raises).
AI_MAX_BRAVE_LOOKUPS_PER_RUN = _env_int("AI_MAX_BRAVE_LOOKUPS_PER_RUN", 10)
AI_CATEGORIZE_TIME_BUDGET_S = _env_float("AI_CATEGORIZE_TIME_BUDGET_S", 300.0)


def _profile_prefs(supabase, user_id: str) -> dict:
    """ai_enabled / ai_provider / ai_confidence_threshold with env fallback.

    DB profile settings are user-facing (Settings page); env vars are the
    operator defaults. Missing columns (pre-migration DB) read as None and
    fall through to env/defaults."""
    try:
        rows = (
            supabase.table("profiles")
            .select("ai_enabled, ai_provider, ai_confidence_threshold")
            .eq("id", user_id)
            .execute()
            .data
            or []
        )
        prof = rows[0] if rows else {}
    except Exception:
        logger.exception("ai pipeline: failed to load profile prefs", extra={"user_id": user_id})
        prof = {}
    threshold = prof.get("ai_confidence_threshold")
    if threshold is None:
        threshold = os.environ.get("AI_CONFIDENCE_THRESHOLD")
    try:
        threshold = float(threshold if threshold is not None else 0.7)
    except (TypeError, ValueError):
        threshold = 0.7
    threshold = max(0.0, min(1.0, threshold))
    provider = prof.get("ai_provider") or os.environ.get("AI_CLASSIFIER_PROVIDER") or "jev"
    enabled = prof.get("ai_enabled")
    if enabled is None:
        enabled = True
    return {"enabled": bool(enabled), "provider": provider, "threshold": threshold}


def _active_categories(supabase, user_id: str) -> list[dict]:
    try:
        return (
            supabase.table("categories")
            .select("id, name")
            .eq("user_id", user_id)
            .eq("is_active", True)
            .execute()
            .data
            or []
        )
    except Exception:
        logger.exception("ai pipeline: failed to load categories", extra={"user_id": user_id})
        return []


def _uncategorized_txns(supabase, user_id: str, limit: int) -> tuple[list[dict], dict]:
    """Uncategorized, non-pending transactions across the user's accounts,
    newest first. Returns (rows, acct_types)."""
    try:
        accounts = (
            supabase.table("accounts").select("id, type").eq("user_id", user_id).execute().data
            or []
        )
    except Exception:
        logger.exception("ai pipeline: failed to load accounts", extra={"user_id": user_id})
        return [], {}
    account_ids = [a["id"] for a in accounts]
    if not account_ids:
        return [], {}
    acct_types = {a["id"]: a.get("type") for a in accounts}
    try:
        rows = (
            supabase.table("transactions")
            .select(
                "id, account_id, date, amount, merchant_name, description, "
                "plaid_category, category_id"
            )
            .in_("account_id", account_ids)
            .is_("category_id", "null")
            .eq("pending", False)
            .order("date", desc=True)
            .limit(limit)
            .execute()
            .data
            or []
        )
    except Exception:
        logger.exception("ai pipeline: failed to load transactions", extra={"user_id": user_id})
        return [], acct_types
    return rows, acct_types


def _state_text(txn: dict, enrichment: str | None = None) -> str:
    merchant = txn.get("merchant_name") or ""
    desc = txn.get("description") or ""
    amount = txn.get("amount")
    try:
        amt = f"${abs(float(amount)):,.2f}"
    except (TypeError, ValueError):
        amt = str(amount)
    direction = "money out (purchase)" if (amount or 0) > 0 else "money in"
    parts = [
        f"Merchant: {merchant or '(unknown)'}",
        f"Description: {desc or '(none)'}",
        f"Amount: {amt} {direction}",
    ]
    if enrichment:
        parts.append(f"Web lookup about this merchant: {enrichment}")
    return "\n".join(parts)


def _cache_lookup(supabase, user_id: str, keys: set[str]) -> dict[str, dict]:
    if not keys:
        return {}
    try:
        rows = (
            supabase.table("ai_category_cache")
            .select("merchant_key, category_id, confidence, source")
            .eq("user_id", user_id)
            .in_("merchant_key", sorted(keys))
            .execute()
            .data
            or []
        )
    except Exception:
        logger.exception("ai pipeline: cache lookup failed", extra={"user_id": user_id})
        return {}
    return {r["merchant_key"]: r for r in rows}


def _cache_store(
    supabase, user_id: str, merchant_key: str, category_id: str, confidence: float, source: str
):
    try:
        supabase.table("ai_category_cache").upsert(
            {
                "user_id": user_id,
                "merchant_key": merchant_key,
                "category_id": category_id,
                "confidence": confidence,
                "source": source,
            },
            on_conflict="user_id,merchant_key",
        ).execute()
    except Exception:
        logger.exception("ai pipeline: cache store failed", extra={"user_id": user_id})


def _apply_verdict(supabase, txn_id: str, category_id: str, confidence: float, source: str):
    supabase.table("transactions").update(
        {
            "category_id": category_id,
            "ai_confidence": confidence,
            "ai_source": source,
        }
    ).eq("id", txn_id).execute()


def run_ai_categorization(supabase, user_id: str) -> dict:
    """Classify the user's uncategorized transactions with the AI provider.

    Returns stats; never raises."""
    stats = {
        "checked": 0,
        "rules_applied": 0,
        "from_cache": 0,
        "ai_applied": 0,
        "needs_review": 0,
        "errors": 0,
    }
    try:
        return _run(supabase, user_id, stats)
    except Exception:
        logger.exception("ai categorization failed", extra={"user_id": user_id})
        stats["errors"] += 1
        return stats


def _run(supabase, user_id: str, stats: dict) -> dict:
    prefs = _profile_prefs(supabase, user_id)
    if not prefs["enabled"]:
        stats["status"] = "disabled"
        return stats

    provider_name = prefs["provider"]
    if (provider_name or "").strip().lower() in ("", "off", "none", "disabled"):
        stats["status"] = "disabled"
        return stats
    threshold = prefs["threshold"]

    categories = _active_categories(supabase, user_id)
    if not categories:
        stats["status"] = "no_categories"
        return stats
    cat_ids = {c["id"] for c in categories}
    cat_choices = [(c["id"], c["name"]) for c in categories]

    txns, acct_types = _uncategorized_txns(supabase, user_id, AI_MAX_TXNS_PER_RUN)
    if not txns:
        stats["status"] = "ok"
        return stats
    stats["checked"] = len(txns)

    # ── 1. deterministic rules first (user-taught; always wins) ──────────
    ctx = load_guess_context(user_id)
    apply_learned(txns, ctx, acct_types)
    for txn in txns:
        if txn.get("category_id"):
            stats["rules_applied"] += 1
            try:
                _apply_verdict(supabase, txn["id"], txn["category_id"], 1.0, "rules")
            except Exception:
                logger.exception(
                    "ai pipeline: failed to persist rule verdict", extra={"user_id": user_id}
                )
                stats["errors"] += 1
    remaining = [t for t in txns if not t.get("category_id")]
    if not remaining:
        stats["status"] = "ok"
        return stats

    # ── 2. merchant cache (repeat merchants never re-call the model) ─────
    keys = {_merchant_key(t) for t in remaining if _merchant_key(t)}
    cache = _cache_lookup(supabase, user_id, keys)
    still = []
    for txn in remaining:
        key = _merchant_key(txn)
        hit = cache.get(key) if key else None
        if hit and hit.get("category_id") in cat_ids:
            stats["from_cache"] += 1
            try:
                _apply_verdict(
                    supabase,
                    txn["id"],
                    hit["category_id"],
                    float(hit.get("confidence") or 0.0),
                    f"cache:{hit.get('source') or 'jev'}",
                )
            except Exception:
                logger.exception(
                    "ai pipeline: failed to persist cache verdict", extra={"user_id": user_id}
                )
                stats["errors"] += 1
        else:
            still.append(txn)
    if not still:
        stats["status"] = "ok"
        return stats

    # ── 3. Jev batch classification ──────────────────────────────────────
    # The provider is constructed only here: rules + cache may already have
    # covered everything, in which case no API key is needed at all.
    try:
        provider = get_provider(provider_name)
    except Exception as e:
        logger.warning("ai pipeline: provider misconfigured: %s", e, extra={"user_id": user_id})
        stats["status"] = "misconfigured"
        stats["errors"] += 1
        stats["needs_review"] += len(still)
        return stats
    assert provider is not None  # 'off' handled above
    items = [(t["id"], _state_text(t), cat_choices) for t in still]
    verdicts = classify_concurrent(provider, items)

    # ── 4. low confidence -> Brave enrich -> ONE re-classify ─────────────
    # Bounded: sequential Brave lookups are capped per run (see the module
    # constants above) and the loop watches the overall time budget. Anything
    # past the cap keeps its step-3 verdict below threshold and lands in the
    # review queue in step 5 — the Jev classification logic itself is
    # untouched, only the enrichment volume is bounded.
    low = [(t, v) for t, v in zip(still, verdicts, strict=True) if v.confidence < threshold]
    if low:
        started = time.monotonic()
        re_items = []
        for n, (txn, _v) in enumerate(low):
            if n >= AI_MAX_BRAVE_LOOKUPS_PER_RUN:
                logger.info("ai pipeline: brave lookup cap reached for this run",
                            extra={"user_id": user_id})
                break
            if time.monotonic() - started > AI_CATEGORIZE_TIME_BUDGET_S:
                logger.warning("ai pipeline: time budget exceeded; skipping enrichment",
                               extra={"user_id": user_id})
                break
            merchant = txn.get("merchant_name") or txn.get("description") or ""
            blurb = lookup_merchant(merchant)
            if blurb:
                re_items.append((txn["id"], _state_text(txn, enrichment=blurb), cat_choices))
        if re_items:
            re_verdicts = classify_concurrent(provider, re_items)
            re_by_id = {tid: v for (tid, _s, _c), v in zip(re_items, re_verdicts, strict=True)}
            verdicts = [re_by_id.get(t["id"], v) for t, v in zip(still, verdicts, strict=True)]

    # ── 5. apply or leave for review ─────────────────────────────────────
    for txn, verdict in zip(still, verdicts, strict=True):
        cid = verdict.category_id
        if cid and cid in cat_ids and verdict.confidence >= threshold:
            stats["ai_applied"] += 1
            try:
                _apply_verdict(supabase, txn["id"], cid, verdict.confidence, provider.name)
                key = _merchant_key(txn)
                if key:
                    _cache_store(supabase, user_id, key, cid, verdict.confidence, provider.name)
            except Exception:
                logger.exception(
                    "ai pipeline: failed to persist ai verdict", extra={"user_id": user_id}
                )
                stats["errors"] += 1
        else:
            stats["needs_review"] += 1

    stats["status"] = "ok"
    return stats
