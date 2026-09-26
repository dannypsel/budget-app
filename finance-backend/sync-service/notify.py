"""Churn-credit notification job (in-app only).

For every user with churning data, generates in-app `notifications` rows for:
  (a) credits expiring within the reminder window with unused value left,
  (b) in-progress signup bonuses whose spend_by_date is within the reminder
      window and still have remaining spend,
  (c) cards whose annual_fee_date / cancel_by_date is within the reminder window.

Reminder windows and per-type on/off switches come from the user's profiles row
(notify_credit_* / notify_bonus_* / notify_fee_*) — a disabled type never
notifies; a credit also honors its own remind_days_before when the profile
value is unset. Each row carries a dedup_key (user_id, dedup_key) that is
unique per period, so a re-run never re-notifies the same period.

Runs inside the manual-refresh chain: POST /sync/trigger (and /backfill-all)
call run_notify(user_ids={...}) after sync + reconcile. The SMTP email digest
that used to ride on the daily scheduler was REMOVED in the 2026-09-26 Lambda
rebuild (no scheduler, so no digests to send); the `profiles.notify_email_enabled`
column still exists in the schema but nothing reads it anymore.

Run:  python notify.py
"""
import datetime
import logging

from logging_setup import setup_logging
from supabase_client import get_supabase, now_iso

logger = logging.getLogger('notify')

# Half-cent slack, mirroring credit_detector.USED_EPS.
USED_EPS = 0.005
# Defaults for the profiles notification columns (see migration
# 20261016000000_settings_preferences.sql) — used when the profile row or the
# columns don't exist yet (pre-migration DBs).
DEFAULT_CREDIT_DAYS = 7
DEFAULT_BONUS_DAYS = 14
DEFAULT_FEE_DAYS = 30


def _to_date(v):
    if v is None or isinstance(v, datetime.date):
        return v
    return datetime.date.fromisoformat(str(v))


def _to_float(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _to_int(v, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _profile_prefs(supabase, user_id: str) -> dict:
    """The user's reminder prefs from profiles: per-type enabled flags and
    lead-time windows. A missing row or missing columns fall back to all-on
    with the DEFAULT_* windows (pre-migration DBs). Never raises."""
    prefs = {
        'notify_credit_enabled': True,
        'notify_credit_days': None,  # None = fall back to each credit's remind_days_before
        'notify_bonus_enabled': True,
        'notify_bonus_days': DEFAULT_BONUS_DAYS,
        'notify_fee_enabled': True,
        'notify_fee_days': DEFAULT_FEE_DAYS,
    }
    try:
        row = supabase.table('profiles').select(
            'notify_credit_enabled, notify_credit_days,'
            ' notify_bonus_enabled, notify_bonus_days,'
            ' notify_fee_enabled, notify_fee_days'
        ).eq('id', user_id).single().execute().data or {}
    except Exception:
        logger.warning('could not read profile prefs for notify',
                       extra={'user_id': user_id}, exc_info=True)
        return prefs
    for key in prefs:
        v = row.get(key)
        if v is not None:
            prefs[key] = v
    return prefs


def _days_until(date_value, today: datetime.date):
    d = _to_date(date_value)
    return (d - today).days if d else None


# ── per-type notification builders (pure: rows only, no DB writes) ────

def _credit_rows(credits: list, cards: dict, today: datetime.date,
                profile_days=None) -> list:
    """Credits with unused value expiring within the reminder window. The
    window is the profile's notify_credit_days when set, else each credit's
    own remind_days_before (default 7)."""
    rows = []
    for credit in credits:
        if not credit.get('reset_date'):
            continue
        window = (profile_days if profile_days is not None
                  else _to_int(credit.get('remind_days_before'), DEFAULT_CREDIT_DAYS))
        days = _days_until(credit['reset_date'], today)
        if days is None or days < 0 or days > window:
            continue
        amount = _to_float(credit.get('amount'))
        used = _to_float(credit.get('used_amount'))
        if not used < amount - USED_EPS:
            continue
        card = cards.get(credit.get('card_id')) or {}
        card_name = card.get('card_name') or 'Card'
        # Stable per cycle: the dedup key must not change within a period, and
        # must differ across periods. period_start_date is set by the detector;
        # fall back to reset_date for rows predating auto-detection.
        period = credit.get('period_start_date') or credit.get('reset_date')
        rows.append({
            'user_id': credit['user_id'],
            'type': 'credit_expiry',
            'title': f"'{credit['credit_name']}' credit expires {credit['reset_date']}",
            'body': (f"${amount - used:,.2f} of ${amount:,.2f} still unused "
                     f"on the {card_name} — use it before {credit['reset_date']}."),
            'data': {'credit_id': credit['id'], 'card_id': credit.get('card_id'),
                     'reset_date': str(credit['reset_date'])},
            'is_read': False,
            'created_at': now_iso(),
            'dedup_key': f"credit:{credit['id']}:{period}",
        })
    return rows


def _bonus_remaining(supabase, bonus: dict, card: dict):
    """Qualifying spend still needed: spend_required minus outflow on the
    linked account within [spend_start_date or card opened_date, spend_by_date].
    Positive amounts only (Plaid convention: money OUT); excluded-from-totals
    rows don't count. None when the bonus can't be measured (no linked account
    or no deadline)."""
    account_id = (card or {}).get('account_id')
    end = _to_date(bonus.get('spend_by_date'))
    if not account_id or end is None:
        return None
    start = _to_date(bonus.get('spend_start_date')) or _to_date((card or {}).get('opened_date'))
    q = supabase.table('transactions') \
        .select('amount, date') \
        .eq('account_id', account_id) \
        .eq('exclude_from_totals', False) \
        .gt('amount', 0) \
        .lte('date', end.isoformat())
    if start:
        q = q.gte('date', start.isoformat())
    outflow = sum(_to_float(t.get('amount')) for t in (q.execute().data or []))
    return _to_float(bonus.get('spend_required')) - outflow


def _bonus_rows(supabase, bonuses: list, cards: dict, today: datetime.date,
               window_days: int) -> list:
    rows = []
    for bonus in bonuses:
        if bonus.get('status') != 'in_progress':
            continue
        days = _days_until(bonus.get('spend_by_date'), today)
        if days is None or days < 0 or days > window_days:
            continue
        remaining = _bonus_remaining(supabase, bonus, cards.get(bonus.get('card_id')))
        if remaining is None or remaining <= USED_EPS:
            continue
        card = cards.get(bonus.get('card_id')) or {}
        card_name = card.get('card_name') or 'Card'
        value = bonus.get('bonus_value')
        rows.append({
            'user_id': bonus['user_id'],
            'type': 'bonus_deadline',
            'title': f"Bonus deadline in {days} day{'s' if days != 1 else ''}",
            'body': (f"Spend ${remaining:,.2f} more on the {card_name} by "
                     f"{bonus['spend_by_date']}"
                     + (f" to earn {value}." if value else ".")),
            'data': {'bonus_id': bonus['id'], 'card_id': bonus.get('card_id'),
                     'spend_by_date': str(bonus['spend_by_date']),
                     'remaining': round(remaining, 2)},
            'is_read': False,
            'created_at': now_iso(),
            'dedup_key': f"bonus:{bonus['id']}:{bonus['spend_by_date']}",
        })
    return rows


def _fee_rows(cards: dict, today: datetime.date, window_days: int) -> list:
    """annual_fee_date / cancel_by_date within the reminder window."""
    rows = []
    for card in cards.values():
        card_name = card.get('card_name') or 'Card'
        annual_fee = _to_float(card.get('annual_fee'))
        for col, ntype, title, body in (
            ('annual_fee_date', 'annual_fee',
             f"Annual fee due for the {card_name}",
             f"${annual_fee:,.2f} posts {card.get('annual_fee_date')} — "
             "use the card's credits first, then decide whether to keep it."),
            ('cancel_by_date', 'cancel_by',
             f"Decide on the {card_name} by {card.get('cancel_by_date')}",
             "Cancel or downgrade before this date to avoid the annual fee."),
        ):
            days = _days_until(card.get(col), today)
            if days is None or days < 0 or days > window_days:
                continue
            rows.append({
                'user_id': card['user_id'],
                'type': ntype,
                'title': title,
                'body': body,
                'data': {'card_id': card['id'], col: str(card[col])},
                'is_read': False,
                'created_at': now_iso(),
                'dedup_key': f"{'fee' if ntype == 'annual_fee' else 'cancel'}:{card['id']}:{card[col]}",
            })
    return rows


# ── orchestration ────────────────────────────────────────────────────

def _churn_user_ids(supabase) -> set:
    """Every user with churning data (cards, credits, or bonuses)."""
    user_ids = set()
    for table in ('churn_cards', 'churn_credits', 'churn_bonuses'):
        try:
            rows = supabase.table(table).select('user_id').execute().data or []
            user_ids |= {r['user_id'] for r in rows if r.get('user_id')}
        except Exception:
            logger.exception('notify: failed to list users', extra={'table': table})
    return user_ids


def _notify_user(supabase, user_id: str, today: datetime.date) -> int:
    """Build and upsert one user's notifications; returns the number of NEW
    rows. on_conflict do-nothing on (user_id, dedup_key) means re-runs add
    nothing for periods already notified. A reminder type disabled in the
    user's profile is skipped entirely."""
    cards = {c['id']: c for c in
             (supabase.table('churn_cards').select('*').eq('user_id', user_id)
              .execute().data or [])}
    credits = supabase.table('churn_credits').select('*') \
        .eq('user_id', user_id).execute().data or []
    bonuses = supabase.table('churn_bonuses').select('*') \
        .eq('user_id', user_id).eq('status', 'in_progress').execute().data or []

    prefs = _profile_prefs(supabase, user_id)
    rows = []
    if prefs['notify_credit_enabled']:
        rows += _credit_rows(credits, cards, today,
                             profile_days=prefs['notify_credit_days'])
    if prefs['notify_bonus_enabled']:
        rows += _bonus_rows(supabase, bonuses, cards, today,
                            window_days=_to_int(prefs['notify_bonus_days'],
                                                DEFAULT_BONUS_DAYS))
    if prefs['notify_fee_enabled']:
        rows += _fee_rows(cards, today,
                          window_days=_to_int(prefs['notify_fee_days'],
                                              DEFAULT_FEE_DAYS))
    if not rows:
        return 0
    res = supabase.table('notifications').upsert(
        rows, on_conflict='user_id,dedup_key', ignore_duplicates=True,
    ).execute()
    new = len(res.data)
    if new:
        logger.info('notifications created', extra={'user_id': user_id, 'new': new})
    return new


def run_notify(supabase=None, today=None, user_ids=None) -> dict:
    """Generate notifications for users with churning data (in-app table only).

    user_ids=None (default) notifies every user with churning data; pass a set
    of ids to scope to specific users (the manual-refresh chain passes the
    single refreshed user). Failure-isolated per user: one bad user never
    takes down the rest. Returns a stats dict."""
    supabase = supabase or get_supabase()
    today = _to_date(today) or datetime.date.today()
    if user_ids is None:
        user_ids = _churn_user_ids(supabase)
    stats = {'users': 0, 'notifications': 0}
    for user_id in sorted(user_ids):
        try:
            stats['notifications'] += _notify_user(supabase, user_id, today)
            stats['users'] += 1
        except Exception:
            logger.exception('notify failed for user', extra={'user_id': user_id})
    logger.info('notify run complete', extra=stats)
    return stats


if __name__ == '__main__':
    setup_logging()
    run_notify()
