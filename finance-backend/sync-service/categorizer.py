import logging

from supabase_client import get_supabase
from transfers import PFC_TRANSFER

logger = logging.getLogger(__name__)

#: Category-name defaults for need/want + fixed/variable auto-classification.
#: Keys are normalized (lowercased, stripped) category names. Categories not
#: listed here leave the tags null — no silent guessing.
CATEGORY_TAG_DEFAULTS: dict[str, tuple[str, str]] = {
    "rent": ("need", "fixed"),
    "mortgage": ("need", "fixed"),
    "groceries": ("need", "variable"),
    "utilities": ("need", "variable"),
    "insurance": ("need", "fixed"),
    "dining": ("want", "variable"),
    "dining & drinks": ("want", "variable"),  # renamed from "Dining"; keep both
    "restaurants": ("want", "variable"),
    "eating out": ("want", "variable"),
    "subscriptions": ("want", "fixed"),
    "shopping": ("want", "variable"),
}

_VALID_NEED_WANT = ("need", "want")
_VALID_SPEND_PATTERN = ("fixed", "variable")


def _merchant_key(txn: dict) -> str:
    """Normalized merchant identity. MUST match the app's Transaction.merchantKey
    (lowercased, trimmed merchant_name, falling back to description)."""
    return (txn.get('merchant_name') or txn.get('description') or '').strip().lower()


def resolve_txn_tags(
    category_name: str | None,
    merchant_key: str | None,
    merchant_tags: dict | None,
) -> tuple[str | None, str | None]:
    """(need_want, spend_pattern) for one transaction, or (None, None).

    Resolution order:
      1. merchant_txn_tags memory — a stored row overrides the category
         default, per field (a null/unknown stored value falls back to the
         category default for that field);
      2. CATEGORY_TAG_DEFAULTS by normalized category name;
      3. unknown category and no memory -> (None, None) — never guesses.

    Never raises: garbage in (or a malformed memory row) yields nulls, and any
    unexpected error degrades to (None, None) so the pipeline can't break.
    """
    try:
        name = category_name if isinstance(category_name, str) else ""
        default = CATEGORY_TAG_DEFAULTS.get(name.strip().lower()) or (None, None)

        mem = (merchant_tags or {}).get(merchant_key)
        if not isinstance(mem, dict):
            mem = {}

        need_want = mem.get("need_want")
        if need_want not in _VALID_NEED_WANT:
            need_want = default[0]

        spend_pattern = mem.get("spend_pattern")
        if spend_pattern not in _VALID_SPEND_PATTERN:
            spend_pattern = default[1]

        return need_want, spend_pattern
    except Exception:
        return None, None


def load_guess_context(user_id: str) -> dict:
    """Everything needed to guess categories for one user:
    learned merchant memory, conditional keyword rules (longest first), and the
    Income id."""
    sb = get_supabase()

    rule_rows = sb.table('category_rules') \
        .select('keyword, category_id, direction, min_amount, max_amount, set_reimbursement') \
        .eq('user_id', user_id) \
        .execute().data or []
    # A rule needs a keyword to match on and at least one action (set a category
    # and/or flag a reimbursement). Legacy rows carry only keyword+category_id and
    # keep behaving exactly as before (direction/min/max null = "any").
    rules = [
        r for r in rule_rows
        if (r.get('keyword') or '').strip()
        and (r.get('category_id') or r.get('set_reimbursement'))
    ]
    rules.sort(key=lambda r: len(r['keyword']), reverse=True)  # specificity, not priority

    mem_rows = sb.table('merchant_categories') \
        .select('merchant_key, category_id') \
        .eq('user_id', user_id) \
        .execute().data or []
    memory = {r['merchant_key']: r['category_id'] for r in mem_rows}

    cats = sb.table('categories') \
        .select('id, name') \
        .eq('user_id', user_id) \
        .execute().data or []
    income_id = next((c['id'] for c in cats if c['name'] == 'Income'), None)

    # Tag context for need_want/spend_pattern: category id -> name for the
    # static defaults, plus merchant_txn_tags memory (merchant overrides win
    # per field). Fails safe to {} on a pre-migration DB so sync never breaks.
    cat_names = {c['id']: c['name'] for c in cats if c.get('id')}
    try:
        tag_rows = sb.table('merchant_txn_tags') \
            .select('merchant_key, need_want, spend_pattern') \
            .eq('user_id', user_id) \
            .execute().data or []
        tag_memory = {r['merchant_key']: r for r in tag_rows if r.get('merchant_key')}
    except Exception:
        logger.exception('load_guess_context: merchant_txn_tags unreadable',
                         extra={'user_id': user_id})
        tag_memory = {}

    return {'rules': rules, 'memory': memory, 'income_id': income_id,
            'cat_names': cat_names, 'tag_memory': tag_memory}


def fill_txn_tags(rows: list[dict], ctx: dict) -> list[dict]:
    """Set need_want/spend_pattern on rows apply_learned already categorized.

    Freshly synced rows that get a category at insert time never enter the
    Jev pipeline (it only fetches category_id IS NULL), so without this they
    would stay untagged until recategorized. Only non-None tags are written;
    unknown categories stay null (never guesses). Never raises.
    """
    try:
        cat_names = (ctx or {}).get('cat_names') or {}
        tag_memory = (ctx or {}).get('tag_memory') or {}
        for r in rows or []:
            if not r.get('category_id'):
                continue
            if r.get('need_want') is not None or r.get('spend_pattern') is not None:
                continue
            need_want, spend_pattern = resolve_txn_tags(
                cat_names.get(r['category_id']), _merchant_key(r), tag_memory)
            if need_want is not None:
                r['need_want'] = need_want
            if spend_pattern is not None:
                r['spend_pattern'] = spend_pattern
    except Exception:
        logger.exception('fill_txn_tags failed; leaving rows untagged')
    return rows


def _rule_matches(rule: dict, txn: dict) -> bool:
    """Does a conditional rule fire on this transaction? ALL present conditions
    must pass: keyword substring (required), then optionally money direction and
    amount magnitude. Sign convention: amount POSITIVE = spend/outflow, NEGATIVE =
    money-in/inflow, so direction 'in' <=> amount < 0 and 'out' <=> amount > 0;
    the min/max bounds compare against ABS(amount) (inclusive). Mirrors
    web categorySuggester.ruleMatches + Swift CategorySuggester.ruleMatches."""
    keyword = (rule.get('keyword') or '').lower()
    if not keyword:
        return False
    hay = ((txn.get('merchant_name') or '') + ' ' + (txn.get('description') or '')).lower()
    if keyword not in hay:
        return False

    amount = txn.get('amount') or 0
    direction = rule.get('direction')
    if direction == 'in' and not amount < 0:
        return False
    if direction == 'out' and not amount > 0:
        return False

    mag = abs(amount)
    lo, hi = rule.get('min_amount'), rule.get('max_amount')
    if lo is not None and mag < lo:
        return False
    if hi is not None and mag > hi:
        return False
    return True


def _is_card_refund(txn: dict, acct_types: dict) -> bool:
    """A credit (amount < 0) on a credit/loan account that isn't a Plaid transfer
    is a refund / return / statement credit — a contra-expense that nets down
    spend, NOT income (a bank reports a card refund as negative spend). Card
    payoffs carry PFC `LOAN_PAYMENTS`, which `PFC_TRANSFER` already excludes, so
    they never get mistaken for a refund. Depository credits (real payroll, Zelle
    in) are intentionally NOT covered — only card/loan accounts."""
    if (txn.get('amount') or 0) >= 0:
        return False
    if (acct_types or {}).get(txn.get('account_id')) not in ('credit', 'loan'):
        return False
    return (txn.get('plaid_category') or '') not in PFC_TRANSFER


def apply_learned(transactions: list[dict], ctx: dict, acct_types: dict = None) -> list[dict]:
    """On sync, auto-apply only high-confidence, user-derived guesses:
    learned merchant memory → conditional keyword rules → income by amount sign.
    A matched rule can set a category and/or flag the row as a reimbursement
    (contra-expense). Plaid-category guesses are intentionally NOT auto-applied —
    they surface in the in-app review flow so the user confirms them (and thereby
    teaches memory).

    `acct_types` maps account_id (uuid) → account type, used to auto-flag credit-
    card refunds as reimbursements (see `_is_card_refund`)."""
    memory = ctx['memory']
    rules = ctx['rules']
    income_id = ctx['income_id']

    for txn in transactions:
        # The most specific (longest-keyword) rule whose conditions all pass wins;
        # `rules` is pre-sorted longest-first. It drives both actions below.
        winner = next((r for r in rules if _rule_matches(r, txn)), None)
        card_refund = _is_card_refund(txn, acct_types)

        if not txn.get('category_id'):
            key = _merchant_key(txn)
            if key and key in memory:
                txn['category_id'] = memory[key]
            elif winner and winner.get('category_id'):
                txn['category_id'] = winner['category_id']
            # positive amount = money out (spend); negative = money in (income).
            # Plaid transfer signals are exempt: a TRANSFER_IN leg is money moved,
            # not income — transfer detection will exclude it instead. A card
            # refund is exempt too: it's a contra-expense, not income (flagged
            # below), and stays uncategorized so it surfaces in the review queue.
            elif income_id and (txn.get('amount') or 0) < 0 \
                    and (txn.get('plaid_category') or '') not in PFC_TRANSFER \
                    and not card_refund:
                txn['category_id'] = income_id

        # Reimbursement is an orthogonal action: flag the credit so it nets its
        # category's spend down instead of counting as income. `is_reimbursement`
        # is user-owned, so this only ever fills it on a brand-new row (default
        # false); the Plaid projection never touches it. A rule can flag it, and a
        # credit-card refund is auto-flagged (the whole point of this pass).
        if (winner and winner.get('set_reimbursement')) or card_refund:
            txn['is_reimbursement'] = True

    return transactions
