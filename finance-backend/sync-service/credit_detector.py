"""Auto-detection of card statement credits (e.g. Amex Gold's $20/month Grubhub).

A churn_credit with auto_detect=true is matched against posted money-IN
transactions (Plaid convention: negative amount = money in / refund) on the
card's linked account. Matching is by merchant keyword (case-insensitive
substring of merchant_name or description) plus an optional target amount with
tolerance. The first match by date wins; the credit row is updated with
used_amount, used_at, detected_transaction_id and detection_source='auto'.

The module also owns cycle rollover: when today reaches a credit's reset_date
(the END of its cycle), the window advances one frequency delta and the
per-cycle used/detected state resets.

All matching / window math lives in pure helpers (no Supabase) so it is unit-
testable; detect_credit_usage orchestrates the DB reads/writes.
"""
import calendar
import datetime
import logging

from supabase_client import now_iso

logger = logging.getLogger('credit_detector')

# Half-cent slack when comparing used_amount against the credit amount —
# the columns are numeric(12,2), so a "fully used" credit reads back exact.
USED_EPS = 0.005

_CYCLE_MONTHS = {'monthly': 1, 'semiannual': 6, 'annual': 12}


def _to_date(v):
    if v is None or isinstance(v, datetime.date):
        return v
    return datetime.date.fromisoformat(str(v))


def _cents(v) -> int:
    """Money in integer cents — float equality against the numeric(12,2)
    column never converges (same rationale as sync.amounts_equal)."""
    return int(round(float(v) * 100))


def _add_months(d: datetime.date, months: int) -> datetime.date:
    """Calendar-month addition, clamping the day (Jan 31 + 1mo = Feb 28)."""
    month = d.month - 1 + months
    year = d.year + month // 12
    month = month % 12 + 1
    last = calendar.monthrange(year, month)[1]
    return datetime.date(year, month, min(d.day, last))


def cycle_delta_months(credit) -> int:
    return _CYCLE_MONTHS.get((credit.get('frequency') or 'annual').lower(), 12)


def cycle_window(credit, today=None):
    """(start_date, end_date) of the credit's current cycle, or None.

    reset_date is the END of the current cycle; the window is
    [reset_date − delta, reset_date). None when the credit has no reset_date
    (no cycle to scope the transaction scan to). Pure — no DB access."""
    reset = _to_date(credit.get('reset_date'))
    if reset is None:
        return None
    return _add_months(reset, -cycle_delta_months(credit)), reset


def txn_matches_credit(credit, txn) -> bool:
    """True if this transaction looks like the credit's statement credit.

    - amount < 0 (Plaid convention: money IN). Positive outflows never match.
    - any detect_merchant_keywords entry as a case-insensitive substring of
      merchant_name or description (empty keywords = any merchant).
    - when detect_amount is set, |amount| must be within detect_tolerance.
    Pure — no DB access."""
    amount = float(txn.get('amount') or 0)
    if amount >= 0:
        return False

    keywords = [k for k in (credit.get('detect_merchant_keywords') or []) if k]
    if keywords:
        haystacks = [str(txn.get('merchant_name') or '').lower(),
                     str(txn.get('description') or '').lower()]
        if not any(k.lower() in h for k in keywords for h in haystacks):
            return False

    target = credit.get('detect_amount')
    if target is not None:
        tolerance = credit.get('detect_tolerance')
        tolerance = float(tolerance) if tolerance is not None else 0.01
        if abs(_cents(abs(amount)) - _cents(target)) > _cents(tolerance):
            return False

    return True


def is_fully_used(credit) -> bool:
    return float(credit.get('used_amount') or 0) >= float(credit.get('amount') or 0) - USED_EPS


def rollover_if_needed(supabase, credit, today=None):
    """If today >= reset_date, advance the cycle window and reset the per-cycle
    state (used_amount, used_at, detected link, dismissals, period start).
    Persists the change; returns the updated credit dict. Advances repeatedly
    so a long-dormant credit lands on the current cycle."""
    today = _to_date(today) or datetime.date.today()
    credit = dict(credit)
    reset = _to_date(credit.get('reset_date'))
    if reset is None:
        return credit

    months = cycle_delta_months(credit)
    new_reset = reset
    while today >= new_reset:
        new_reset = _add_months(new_reset, months)
    if new_reset == reset:
        return credit

    patch = {
        'reset_date': new_reset.isoformat(),
        'period_start_date': _add_months(new_reset, -months).isoformat(),
        'used_amount': 0,
        'used_at': None,
        'detected_transaction_id': None,
        'detection_source': None,
        'detection_dismissed_transaction_ids': [],
    }
    supabase.table('churn_credits').update(patch).eq('id', credit['id']).execute()
    credit.update(patch)
    logger.info('credit cycle rolled over',
                extra={'credit_id': credit['id'], 'new_reset_date': patch['reset_date']})
    return credit


def detect_credit_usage(supabase, user_id, today=None) -> dict:
    """Scan the user's auto-detect credits against fresh transactions and mark
    any whose statement credit posted. Returns {'checked', 'detected',
    'credits': [credit ids]}. Never raises — a failure is logged and counted,
    so callers may also wrap it without breaking the sync pipeline."""
    today = _to_date(today) or datetime.date.today()
    stats = {'checked': 0, 'detected': 0, 'credits': [], 'errors': 0}

    try:
        credits = supabase.table('churn_credits').select('*') \
            .eq('user_id', user_id).execute().data or []
    except Exception:
        logger.exception('credit detection: failed to load credits',
                         extra={'user_id': user_id})
        return stats

    # Card → linked account, so each credit scans its own card's transactions.
    card_ids = list({c.get('card_id') for c in credits if c.get('card_id')})
    account_by_card = {}
    if card_ids:
        try:
            cards = supabase.table('churn_cards').select('id, account_id') \
                .in_('id', card_ids).execute().data or []
            account_by_card = {c['id']: c.get('account_id') for c in cards}
        except Exception:
            logger.exception('credit detection: failed to load cards',
                             extra={'user_id': user_id})

    # Transaction ids already claimed as another credit's detection (same user)
    # must never double-match.
    claimed = {c.get('detected_transaction_id') for c in credits
               if c.get('detected_transaction_id')}

    for credit in credits:
        try:
            if not credit.get('auto_detect', True):
                continue
            account_id = account_by_card.get(credit.get('card_id'))
            if not account_id:
                continue

            credit = rollover_if_needed(supabase, credit, today)
            stats['checked'] += 1

            # Already resolved this cycle (auto or manual) or fully used.
            if credit.get('detection_source') is not None or is_fully_used(credit):
                continue

            window = cycle_window(credit, today)
            if window is None:
                continue
            start, end = window
            dismissed = set(credit.get('detection_dismissed_transaction_ids') or [])

            txns = supabase.table('transactions') \
                .select('id, account_id, date, amount, merchant_name, description, pending') \
                .eq('account_id', account_id) \
                .eq('pending', False) \
                .gte('date', start.isoformat()) \
                .lt('date', end.isoformat()) \
                .lt('amount', 0) \
                .execute().data or []
            # First match by date asc wins (stable tiebreak on id).
            txns.sort(key=lambda t: (str(t.get('date') or ''), str(t.get('id') or '')))

            for txn in txns:
                if txn['id'] in dismissed or txn['id'] in claimed:
                    continue
                if not txn_matches_credit(credit, txn):
                    continue
                used = round(min(abs(float(txn['amount'])), float(credit['amount'])), 2)
                supabase.table('churn_credits').update({
                    'used_amount': used,
                    'used_at': now_iso(),
                    'detected_transaction_id': txn['id'],
                    'detection_source': 'auto',
                    'period_start_date': start.isoformat(),
                }).eq('id', credit['id']).execute()
                claimed.add(txn['id'])
                stats['detected'] += 1
                stats['credits'].append(credit['id'])
                logger.info('credit auto-detected',
                            extra={'credit_id': credit['id'], 'transaction_id': txn['id'],
                                   'used_amount': used})
                break
        except Exception:
            stats['errors'] += 1
            logger.exception('credit detection failed for credit',
                             extra={'credit_id': credit.get('id'), 'user_id': user_id})

    return stats
