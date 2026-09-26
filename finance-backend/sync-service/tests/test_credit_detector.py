"""Credit auto-detection + notification pipeline tests.

Covers credit_detector.py (matching, tolerance, rollover, skip rules) and
notify.py (expiry/bonus/fee notifications, dedupe, bonus math), plus the sync
hook and the POST /credits/detect endpoint. Fakes only — no network, no
credentials, no live DB.

Plaid amount convention throughout: positive = money OUT, negative = money IN
(statement credits post as negative amounts).
"""
import datetime
import types

import pytest

import credit_detector
import notify
import sync
from tests.fakes import FakeSupabase

USER = "user-1"
TODAY = datetime.date(2026, 9, 25)


# ── builders ─────────────────────────────────────────────────────────

def _card(card_id="card-1", account_id="acct-1", **kw):
    row = {"id": card_id, "user_id": USER, "card_name": "Amex Gold",
           "issuer": "Amex", "last4": "1234", "opened_date": "2026-01-15",
           "annual_fee": 250, "annual_fee_date": None, "cancel_by_date": None,
           "account_id": account_id}
    row.update(kw)
    return row


def _credit(credit_id="credit-1", card_id="card-1", **kw):
    row = {"id": credit_id, "user_id": USER, "card_id": card_id,
           "credit_name": "Grubhub", "amount": 20.00, "frequency": "monthly",
           "auto_detect": True, "detect_merchant_keywords": ["grubhub"],
           "detect_amount": 20.00, "detect_tolerance": 0.01,
           "used_amount": 0, "reset_date": "2026-10-01",
           "period_start_date": "2026-09-01",
           "used_at": None, "detected_transaction_id": None,
           "detection_source": None,
           "detection_dismissed_transaction_ids": [],
           "remind_days_before": 7}
    row.update(kw)
    return row


def _txn(txn_id, account_id="acct-1", date="2026-09-10", amount=-20.00,
         merchant_name="GRUBHUB", description="GRUBHUB", pending=False, **kw):
    row = {"id": txn_id, "user_id": USER, "account_id": account_id,
           "date": date, "amount": amount, "merchant_name": merchant_name,
           "description": description, "pending": pending}
    row.update(kw)
    return row


def _bonus(bonus_id="bonus-1", card_id="card-1", **kw):
    row = {"id": bonus_id, "user_id": USER, "card_id": card_id,
           "description": "100k points", "spend_required": 4000,
           "spend_start_date": None, "spend_by_date": "2026-10-05",
           "bonus_value": "100k MR", "status": "in_progress"}
    row.update(kw)
    return row


def _sb(*, cards=(), credits=(), txns=(), bonuses=(), profiles=()):
    return FakeSupabase(tables={
        "churn_cards": list(cards),
        "churn_credits": list(credits),
        "transactions": list(txns),
        "churn_bonuses": list(bonuses),
        "profiles": list(profiles),
    })


# ── pure helpers: window math ────────────────────────────────────────

def test_cycle_window_monthly():
    start, end = credit_detector.cycle_window(_credit(reset_date="2026-10-01"), TODAY)
    assert (start, end) == (datetime.date(2026, 9, 1), datetime.date(2026, 10, 1))


def test_cycle_window_semiannual_and_annual():
    start, end = credit_detector.cycle_window(
        _credit(frequency="semiannual", reset_date="2026-07-01"), TODAY)
    assert (start, end) == (datetime.date(2026, 1, 1), datetime.date(2026, 7, 1))
    start, end = credit_detector.cycle_window(
        _credit(frequency="annual", reset_date="2026-12-31"), TODAY)
    assert (start, end) == (datetime.date(2025, 12, 31), datetime.date(2026, 12, 31))


def test_cycle_window_month_end_clamp():
    # Jan 31 reset − 1 month clamps to Feb 28, not Mar 3.
    start, _ = credit_detector.cycle_window(
        _credit(reset_date="2027-01-31"), datetime.date(2027, 1, 15))
    assert start == datetime.date(2026, 12, 31)


def test_cycle_window_none_without_reset_date():
    assert credit_detector.cycle_window(_credit(reset_date=None), TODAY) is None


# ── pure helper: matching ───────────────────────────────────────────

def test_matcher_ignores_positive_outflow():
    credit = _credit()
    out = _txn("t-out", amount=20.00)          # a Grubhub *purchase*
    assert credit_detector.txn_matches_credit(credit, out) is False
    credit_txn = _txn("t-in", amount=-20.00)   # the statement credit
    assert credit_detector.txn_matches_credit(credit, credit_txn) is True


def test_matcher_keyword_case_insensitive_merchant_and_description():
    credit = _credit(detect_merchant_keywords=["GrubHub"])
    assert credit_detector.txn_matches_credit(
        credit, _txn("a", merchant_name="GRUBHUB*SEATTLE WA")) is True
    # Keyword only in the description (merchant_name is something else).
    assert credit_detector.txn_matches_credit(
        credit, _txn("b", merchant_name="AMEX", description="grubhub credit")) is True
    assert credit_detector.txn_matches_credit(
        credit, _txn("c", merchant_name="AMEX", description="lounge credit")) is False


def test_matcher_empty_keywords_matches_any_merchant():
    credit = _credit(detect_merchant_keywords=[], detect_amount=None)
    assert credit_detector.txn_matches_credit(
        credit, _txn("a", merchant_name="SOME RANDOM MERCHANT", amount=-7.50)) is True


def test_matcher_tolerance_boundaries():
    credit = _credit(detect_amount=20.00, detect_tolerance=0.01)
    # Exactly at tolerance (1 cent off) still matches; 2 cents off does not.
    assert credit_detector.txn_matches_credit(credit, _txn("a", amount=-20.01)) is True
    assert credit_detector.txn_matches_credit(credit, _txn("b", amount=-20.02)) is False
    assert credit_detector.txn_matches_credit(credit, _txn("c", amount=-19.99)) is True


def test_matcher_null_detect_amount_matches_any_amount():
    credit = _credit(detect_amount=None)
    assert credit_detector.txn_matches_credit(credit, _txn("a", amount=-3.17)) is True
    assert credit_detector.txn_matches_credit(credit, _txn("b", amount=-250.00)) is True


# ── rollover ─────────────────────────────────────────────────────────

def test_rollover_advances_and_resets_cycle_state():
    sb = _sb(cards=[_card()],
             credits=[_credit(reset_date="2026-09-01", period_start_date="2026-08-01",
                              used_amount=20.00, used_at="2026-08-20T00:00:00+00:00",
                              detected_transaction_id="t-old", detection_source="auto",
                              detection_dismissed_transaction_ids=["t-x"])])
    rolled = credit_detector.rollover_if_needed(sb, sb.one("churn_credits", id="credit-1"), TODAY)
    assert rolled["reset_date"] == "2026-10-01"
    assert rolled["period_start_date"] == "2026-09-01"
    assert rolled["used_amount"] == 0
    assert rolled["used_at"] is None
    assert rolled["detected_transaction_id"] is None
    assert rolled["detection_source"] is None
    assert rolled["detection_dismissed_transaction_ids"] == []
    # Persisted, not just returned.
    assert sb.one("churn_credits", id="credit-1")["reset_date"] == "2026-10-01"


def test_rollover_skips_multiple_dormant_cycles():
    sb = _sb(credits=[_credit(reset_date="2026-06-01", period_start_date="2026-05-01")])
    rolled = credit_detector.rollover_if_needed(sb, sb.one("churn_credits", id="credit-1"), TODAY)
    assert rolled["reset_date"] == "2026-10-01"
    assert rolled["period_start_date"] == "2026-09-01"


def test_rollover_noop_before_reset_date():
    sb = _sb(credits=[_credit(reset_date="2026-10-01", used_amount=5)])
    rolled = credit_detector.rollover_if_needed(sb, sb.one("churn_credits", id="credit-1"), TODAY)
    assert rolled["reset_date"] == "2026-10-01"
    assert rolled["used_amount"] == 5
    assert not any(c[0] == "churn_credits" and c[1] == "update" for c in sb.calls)


# ── end-to-end detection ─────────────────────────────────────────────

def test_detect_marks_credit_used_on_first_match_by_date():
    sb = _sb(cards=[_card()],
             credits=[_credit()],
             txns=[_txn("t-late", date="2026-09-20"),
                   _txn("t-early", date="2026-09-05"),   # wins: earliest date
                   _txn("t-purchase", date="2026-09-01", amount=20.00)])
    stats = credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert stats["detected"] == 1
    assert stats["credits"] == ["credit-1"]
    credit = sb.one("churn_credits", id="credit-1")
    assert credit["used_amount"] == 20.00
    assert credit["detected_transaction_id"] == "t-early"
    assert credit["detection_source"] == "auto"
    assert credit["used_at"] is not None
    assert credit["period_start_date"] == "2026-09-01"


def test_detect_caps_used_amount_at_credit_amount():
    sb = _sb(cards=[_card()],
             credits=[_credit(detect_amount=None)],   # any amount matches
             txns=[_txn("t-big", amount=-45.00, merchant_name="grubhub refund")])
    credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert sb.one("churn_credits", id="credit-1")["used_amount"] == 20.00


def test_detect_skips_pending_and_out_of_window_and_wrong_account():
    sb = _sb(cards=[_card()],
             credits=[_credit()],
             txns=[
                 _txn("t-pending", date="2026-09-10", pending=True),
                 _txn("t-old", date="2026-08-15"),                       # before window
                 _txn("t-future", date="2026-10-02"),                    # on/after reset
                 _txn("t-other-acct", date="2026-09-10", account_id="acct-2"),
             ])
    stats = credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert stats["detected"] == 0


def test_detect_skips_dismissed_transaction_ids():
    sb = _sb(cards=[_card()],
             credits=[_credit(detection_dismissed_transaction_ids=["t-1"])],
             txns=[_txn("t-1")])
    stats = credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert stats["detected"] == 0
    # …and a dismissed id is never re-matched on a later run either.
    assert credit_detector.detect_credit_usage(sb, USER, TODAY)["detected"] == 0


def test_detect_manual_source_blocks_auto():
    sb = _sb(cards=[_card()],
             credits=[_credit(detection_source="manual", used_amount=20.00)],
             txns=[_txn("t-1")])
    stats = credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert stats["detected"] == 0
    assert sb.one("churn_credits", id="credit-1")["detection_source"] == "manual"


def test_detect_skips_fully_used_and_opted_out_and_unlinked():
    sb = _sb(
        cards=[_card()],
        credits=[
            _credit("c-used", used_amount=20.00),
            _credit("c-off", auto_detect=False),
            _credit("c-nocard", card_id="card-9"),   # card-9 doesn't exist
        ],
        txns=[_txn("t-1")],
    )
    stats = credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert stats["checked"] == 1          # only c-used reached the skip checks
    assert stats["detected"] == 0


def test_detect_same_transaction_never_claimed_twice():
    sb = _sb(cards=[_card()],
             credits=[_credit("c-1", detect_amount=None),
                      _credit("c-2", credit_name="Dining", detect_amount=None)],
             txns=[_txn("t-1", amount=-9.99)])
    stats = credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert stats["detected"] == 1       # one txn → one credit
    assert stats["credits"] == ["c-1"]
    assert sb.one("churn_credits", id="c-2")["detection_source"] is None


def test_detect_never_raises_and_counts_errors(monkeypatch):
    sb = _sb(cards=[_card()], credits=[_credit()], txns=[_txn("t-1")])
    monkeypatch.setattr(sb, "table",
                        lambda name: (_ for _ in ()).throw(RuntimeError("db down")))
    stats = credit_detector.detect_credit_usage(sb, USER, TODAY)
    assert stats["detected"] == 0


# ── sync hook ────────────────────────────────────────────────────────

def test_finalize_user_runs_credit_detection(monkeypatch):
    sb = _sb()
    seen = []
    monkeypatch.setattr(sync, "detect_credit_usage",
                        lambda supabase, user_id, today=None: seen.append(user_id))
    sync._finalize_user(sb, USER, full=False)
    assert seen == [USER]


def test_finalize_user_survives_detector_crash(monkeypatch):
    sb = _sb()

    def boom(supabase, user_id, today=None):
        raise RuntimeError("detector down")
    monkeypatch.setattr(sync, "detect_credit_usage", boom)
    sync._finalize_user(sb, USER, full=False)   # must not raise


# ── POST /credits/detect ─────────────────────────────────────────────

def _api_client(monkeypatch):
    from fastapi.testclient import TestClient

    import api
    orig_auth = api._user_id_from_token
    monkeypatch.setattr(api, "_user_id_from_token", lambda token: USER)
    monkeypatch.setattr(api, "get_supabase", lambda: FakeSupabase(tables={}))
    return TestClient(api.app, raise_server_exceptions=False), api, orig_auth


def test_credits_detect_endpoint(monkeypatch):
    client, _, _ = _api_client(monkeypatch)
    monkeypatch.setattr(
        credit_detector, "detect_credit_usage",
        lambda supabase, user_id, today=None: {"checked": 2, "detected": 1, "credits": ["c-1"]})
    resp = client.post("/credits/detect", headers={"Authorization": "Bearer x"})
    assert resp.status_code == 200
    assert resp.json() == {"detected": 1, "credits": ["c-1"]}


def test_credits_detect_endpoint_401_without_token(monkeypatch):
    client, api, orig_auth = _api_client(monkeypatch)
    monkeypatch.setattr(api, "_user_id_from_token", orig_auth)
    resp = client.post("/credits/detect")
    assert resp.status_code == 401


# ── notify: credits ──────────────────────────────────────────────────

def test_notify_credit_expiry_fires_once_per_period():
    sb = _sb(cards=[_card()],
             credits=[_credit(reset_date="2026-09-28")])   # 3 days out, 7-day reminder
    stats = notify.run_notify(supabase=sb, today=TODAY)
    assert stats["notifications"] == 1
    row = sb.one("notifications", type="credit_expiry")
    assert row["dedup_key"] == "credit:credit-1:2026-09-01"
    assert "Grubhub" in row["title"]
    assert row["is_read"] is False
    # Second run: same period → deduped, no new row.
    stats2 = notify.run_notify(supabase=sb, today=TODAY)
    assert stats2["notifications"] == 0
    assert len(sb.rows("notifications")) == 1


@pytest.mark.parametrize("kw", [
    {"used_amount": 20.00},                 # fully used
    {"reset_date": "2026-09-24"},           # already expired
    {"reset_date": "2026-10-20"},           # beyond remind_days_before
    {"reset_date": None},                  # no cycle
])
def test_notify_credit_expiry_skips(kw):
    sb = _sb(cards=[_card()], credits=[_credit(**kw)])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


def test_notify_partial_use_reports_remaining():
    sb = _sb(cards=[_card()], credits=[_credit(used_amount=12.50, reset_date="2026-09-28")])
    notify.run_notify(supabase=sb, today=TODAY)
    row = sb.one("notifications", type="credit_expiry")
    assert "$7.50" in row["body"]


# ── notify: bonuses ──────────────────────────────────────────────────

def test_notify_bonus_deadline_with_remaining_spend():
    sb = _sb(
        cards=[_card()],
        bonuses=[_bonus()],                                   # due 2026-10-05 (10d)
        txns=[
            _txn("t-spend", date="2026-09-10", amount=3000.00, merchant_name="STORE"),
            _txn("t-refund", date="2026-09-11", amount=-200.00, merchant_name="STORE"),
            _txn("t-excl", date="2026-09-12", amount=500.00, merchant_name="STORE",
                 exclude_from_totals=True),
            _txn("t-old", date="2025-12-01", amount=900.00, merchant_name="STORE"),
        ],
    )
    stats = notify.run_notify(supabase=sb, today=TODAY)
    assert stats["notifications"] == 1
    row = sb.one("notifications", type="bonus_deadline")
    # 4000 − 3000 = 1000 remaining: refund ignored (inflow), excluded ignored,
    # pre-window spend ignored.
    assert row["dedup_key"] == "bonus:bonus-1:2026-10-05"
    assert "$1,000.00" in row["body"]
    assert row["data"]["remaining"] == 1000.00


@pytest.mark.parametrize("kw", [
    {"spend_by_date": "2026-10-20"},    # 25 days out — beyond the 14-day window
    {"spend_by_date": "2026-09-20"},    # already passed
    {"status": "completed"},            # not in progress
])
def test_notify_bonus_skips(kw):
    sb = _sb(cards=[_card()], bonuses=[_bonus(**kw)])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


def test_notify_bonus_no_notification_when_spend_met():
    sb = _sb(
        cards=[_card()],
        bonuses=[_bonus()],
        txns=[_txn("t-spend", date="2026-09-10", amount=4000.00, merchant_name="STORE")],
    )
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


def test_notify_bonus_unlinked_card_is_skipped():
    sb = _sb(cards=[_card("card-9", account_id=None)], bonuses=[_bonus(card_id="card-9")])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


# ── notify: fees ─────────────────────────────────────────────────────

def test_notify_annual_fee_and_cancel_by():
    sb = _sb(cards=[
        _card("card-1", annual_fee_date="2026-10-05", cancel_by_date="2026-11-10"),
        _card("card-2", card_name="Chase Sapphire", annual_fee_date=None,
              cancel_by_date="2026-09-30"),
    ])
    stats = notify.run_notify(supabase=sb, today=TODAY)
    assert stats["notifications"] == 2
    fee = sb.one("notifications", type="annual_fee")
    assert fee["dedup_key"] == "fee:card-1:2026-10-05"
    assert "$250.00" in fee["body"]
    cancel = sb.one("notifications", type="cancel_by")
    assert cancel["dedup_key"] == "cancel:card-2:2026-09-30"
    # card-1's cancel_by (46 days out) is beyond the 30-day window → skipped.


def test_notify_fee_outside_window_skipped():
    sb = _sb(cards=[_card(annual_fee_date="2026-11-01", cancel_by_date="2026-09-20")])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


# ── notify: profile prefs (enabled flags + lead-time windows) ────

def _prefs(**kw):
    row = {"id": USER}
    row.update(kw)
    return [row]


def test_notify_type_disabled_skips_credits():
    sb = _sb(cards=[_card()], credits=[_credit(reset_date="2026-09-28")],
             profiles=_prefs(notify_credit_enabled=False))
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


def test_notify_type_disabled_skips_bonus():
    sb = _sb(cards=[_card()], bonuses=[_bonus()], profiles=_prefs(notify_bonus_enabled=False))
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


def test_notify_type_disabled_skips_fees():
    sb = _sb(cards=[_card(annual_fee_date="2026-10-05")],
             profiles=_prefs(notify_fee_enabled=False))
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0


def test_notify_disabling_one_type_keeps_others():
    # Credit reminders off, but the bonus deadline still fires.
    sb = _sb(cards=[_card()], credits=[_credit(reset_date="2026-09-28")],
             bonuses=[_bonus()], profiles=_prefs(notify_credit_enabled=False))
    stats = notify.run_notify(supabase=sb, today=TODAY)
    assert stats["notifications"] == 1
    assert sb.one("notifications", type="bonus_deadline") is not None


def test_notify_credit_profile_days_override():
    # Reset 10 days out: the credit's own remind_days_before=7 skips it, but a
    # profile window of 14 fires.
    sb = _sb(cards=[_card()], credits=[_credit(reset_date="2026-10-05")])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0
    sb2 = _sb(cards=[_card()], credits=[_credit(reset_date="2026-10-05")],
              profiles=_prefs(notify_credit_days=14))
    assert notify.run_notify(supabase=sb2, today=TODAY)["notifications"] == 1


def test_notify_credit_falls_back_to_remind_days_before():
    # Profile row without notify_credit_days set → each credit's own
    # remind_days_before governs (3 here: 2 days out fires, 5 skipped).
    sb = _sb(cards=[_card()],
             credits=[_credit(remind_days_before=3, reset_date="2026-09-27")],
             profiles=_prefs())
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 1
    sb2 = _sb(cards=[_card()],
              credits=[_credit(remind_days_before=3, reset_date="2026-09-30")],
              profiles=_prefs())
    assert notify.run_notify(supabase=sb2, today=TODAY)["notifications"] == 0


def test_notify_bonus_profile_days_override():
    # Bonus due 20 days out: default 14-day window skips; profile 30 fires.
    sb = _sb(cards=[_card()], bonuses=[_bonus(spend_by_date="2026-10-15")])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0
    sb2 = _sb(cards=[_card()], bonuses=[_bonus(spend_by_date="2026-10-15")],
              profiles=_prefs(notify_bonus_days=30))
    assert notify.run_notify(supabase=sb2, today=TODAY)["notifications"] == 1


def test_notify_fee_profile_days_override():
    # Fee 40 days out: default 30-day window skips; profile 60 fires.
    sb = _sb(cards=[_card(annual_fee_date="2026-11-04")])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 0
    sb2 = _sb(cards=[_card(annual_fee_date="2026-11-04")],
              profiles=_prefs(notify_fee_days=60))
    assert notify.run_notify(supabase=sb2, today=TODAY)["notifications"] == 1


def test_notify_no_profile_row_uses_defaults():
    # Pre-migration DBs have no profiles row → all types on, default windows.
    sb = _sb(cards=[_card()], credits=[_credit(reset_date="2026-09-28")])
    assert notify.run_notify(supabase=sb, today=TODAY)["notifications"] == 1



# ── notify: isolation + email digest ─────────────────────────────────

def test_notify_isolates_per_user_failure(monkeypatch):
    sb = _sb(cards=[_card(), _card("card-2", account_id="acct-2")],
             credits=[_credit(reset_date="2026-09-28")])

    real_notify_user = notify._notify_user

    def flaky(supabase, user_id, today):
        if user_id == "user-1":
            raise RuntimeError("boom")
        return real_notify_user(supabase, user_id, today)

    monkeypatch.setattr(notify, "_notify_user", flaky)
    # Single user here — the point is the exception is swallowed, not raised.
    stats = notify.run_notify(supabase=sb, today=TODAY)
    assert stats["notifications"] == 0


def _stub_auth(sb, email="user@example.com"):
    sb.auth = types.SimpleNamespace(
        admin=types.SimpleNamespace(
            get_user_by_id=lambda uid: types.SimpleNamespace(
                user=types.SimpleNamespace(email=email))))
