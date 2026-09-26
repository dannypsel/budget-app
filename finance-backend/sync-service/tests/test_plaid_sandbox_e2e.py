"""Plaid SANDBOX end-to-end test for the account-adding flow.

The account-adding flow (link a bank → exchange token → accounts + transactions
sync → repeat for each new card) is the most-used flow in this app, so this
test exercises it against the REAL Plaid sandbox API, calling the repo's actual
route handlers (`api.link_prepare`, `api.link_exchange`)
and sync entry points (`sync.run_sync`, `sync.run_sync_for_item`).

────────────────────────────────────────────────────────────────────────────
HOW TO RUN (live — needs Plaid sandbox credentials, nothing else)
────────────────────────────────────────────────────────────────────────────
1. Get FREE sandbox keys (no approval, no credit card — sandbox is free):
     Plaid Dashboard → Team Settings → Keys → copy the SANDBOX client_id
     and sandbox secret. (dashboard.plaid.com → Developers → API keys.)

2. Export them in your shell:

     export PLAID_CLIENT_ID=<your 24-char sandbox client_id>
     export PLAID_SECRET=<your 30-char sandbox secret>
     export PLAID_ENV=sandbox

   (plaid_client.py prefers PLAID_SANDBOX_SECRET over PLAID_SECRET if both are
   set; either works. PLAID_ENV must be "sandbox" — plaid_client maps it to
   Plaid's sandbox host on every call via house_creds(); the test enforces
   this so you can never accidentally run it against production.)

3. Run:

     cd finance-backend/sync-service
     PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \
         pytest -m integration tests/test_plaid_sandbox_e2e.py -v

No local Supabase is needed — the test uses the repo's in-memory FakeSupabase
for the DB. Only Plaid sandbox traffic is real. Everything created on Plaid's
side (items, access tokens) is removed at test end via /item/remove so nothing
counts against the developer account's Item cap.

SKIP BEHAVIOR: the whole module is marked `integration` and is skipped unless
PLAID_CLIENT_ID and PLAID_SECRET are set, so `pytest -m "not integration"`
never touches it.

SCOPE LIMITS (what is NOT exercised headless):
  * The hosted /link page is browser UI — this test calls the underlying
    handler `link_prepare` directly instead of driving a browser.
  * /sandbox/public_token/create replaces the Plaid Link UI handshake
    (institution ins_109508 = First Platypus Bank) to mint the public_token
    that `link_exchange` consumes.
"""

import datetime
import json
import os

import pytest
from cryptography.fernet import Fernet
from plaid.model.custom_sandbox_transaction import CustomSandboxTransaction
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.products import Products
from plaid.model.sandbox_public_token_create_request import (
    SandboxPublicTokenCreateRequest,
)
from plaid.model.sandbox_transactions_create_request import (
    SandboxTransactionsCreateRequest,
)

import api
import plaid_client
import sync
import vault
from tests.fakes import FakeSupabase

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not (os.environ.get("PLAID_CLIENT_ID") and os.environ.get("PLAID_SECRET")),
        reason="needs Plaid sandbox credentials (PLAID_CLIENT_ID + PLAID_SECRET)",
    ),
]

USER_ID = "e2e-user-00000000-0000-0000-0000-000000000001"
INSTITUTION_ID = "ins_109508"  # First Platypus Bank (sandbox test bank)
INSTITUTION_NAME = "First Platypus Bank"


# ── fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def db(monkeypatch):
    """In-memory DB + forced sandbox env + patched auth, exactly like the
    fakes-only logic tests (see tests/test_delete_item.py for the pattern)."""
    store = FakeSupabase()
    monkeypatch.setattr(api, "get_supabase", lambda: store)
    monkeypatch.setattr(sync, "get_supabase", lambda: store)
    monkeypatch.setattr(api, "_user_id_from_token", lambda token: USER_ID)

    # Force sandbox semantics: plaid_client.house_creds() reads PLAID_ENV on
    # every call, so pinning it here guarantees no production traffic even if
    # the caller's env var was left as 'production'.
    monkeypatch.setenv("PLAID_ENV", "sandbox")
    assert plaid_client.house_creds()["env"] == "sandbox"

    # Throwaway vault key for this process only (sandbox access tokens are
    # encrypted at rest exactly like production ones).
    monkeypatch.setenv("CREDENTIALS_ENC_KEY", Fernet.generate_key().decode())
    vault._fernet = None  # reset the cached Fernet so it picks up the new key

    # Categorization context is orthogonal to this flow; skip the lookup.
    monkeypatch.setattr(
        sync,
        "load_guess_context",
        lambda uid: {"memory": {}, "rules": [], "income_id": None},
    )
    return store


# ── helpers (no credential values are ever logged or asserted on) ───────────


def _house_plaid():
    """Real PlaidApi client against the sandbox, built from env credentials."""
    creds = plaid_client.house_creds()
    assert creds is not None, "house creds missing — PLAID_CLIENT_ID/PLAID_SECRET unset?"
    assert creds["env"] == "sandbox", "refusing to run against non-sandbox env"
    return plaid_client.get_plaid_for_creds(creds)


def _link_and_exchange(client, db):
    """link token → sandbox public token → repo exchange handler → item UUID."""
    prep = api.link_prepare(authorization="Bearer test-jwt", payload=None)
    assert prep["status"] == "ok", f"link_prepare failed: {prep}"
    assert prep.get("link_token"), "no link token returned"

    public_token = client.sandbox_public_token_create(
        SandboxPublicTokenCreateRequest(
            institution_id=INSTITUTION_ID,
            initial_products=[Products("transactions")],
        )
    ).to_dict()["public_token"]

    resp = api.link_exchange(
        {
            "access_token": "Bearer test-jwt",
            "public_token": public_token,
            "metadata": {
                "institution": {"institution_id": INSTITUTION_ID, "name": INSTITUTION_NAME}
            },
        }
    )
    body = json.loads(resp.body)
    assert body["institution"] == INSTITUTION_NAME
    item_id = body["item_id"]

    # The fake DB doesn't mirror Postgres column defaults
    # (plaid_items.is_active default true, is_syncing default false — see
    # 20260101000000_init.sql / 20260703000000_sync_perf.sql), but sync paths
    # filter on them, so apply the defaults the real DB would have supplied.
    db.table("plaid_items").update({"is_active": True, "is_syncing": False}).eq(
        "id", item_id
    ).execute()
    return item_id


def _accounts_for(db, item_uuid):
    return [r for r in db.rows("accounts") if r.get("plaid_item_id") == item_uuid]


def _transactions_for(db, item_uuid):
    acct_ids = {a["id"] for a in _accounts_for(db, item_uuid)}
    return [r for r in db.rows("transactions") if r.get("account_id") in acct_ids]


def _remove_item(client, db, item_uuid):
    """Sever the sandbox item on Plaid's side (/item/remove), then drop the
    local rows — mirrors what DELETE /items/{id} does in production."""
    row = db.one("plaid_items", id=item_uuid)
    if row is None:
        return
    try:
        client.item_remove(ItemRemoveRequest(access_token=vault.decrypt(row["access_token"])))
    except Exception:
        pass  # best-effort: Plaid-side removal must not fail cleanup
    acct_ids = {a["id"] for a in _accounts_for(db, item_uuid)}
    store = db.tables
    store["transactions"] = [
        t for t in store.get("transactions", []) if t.get("account_id") not in acct_ids
    ]
    store["accounts"] = [
        a for a in store.get("accounts", []) if a.get("plaid_item_id") != item_uuid
    ]
    store["plaid_items"] = [i for i in store.get("plaid_items", []) if i.get("id") != item_uuid]


# ── the test ───────────────────────────────────────────────────────────────


def test_plaid_sandbox_e2e_account_adding_flow(db):
    """Full account-adding flow against Plaid sandbox: two items linked (the
    user opens new cards often), cursor-based sync, and an incremental sync
    pulling newly posted transactions."""
    client = _house_plaid()
    items = []

    try:
        # ── (a)+(b)+(c) item 1: link token → sandbox public token → exchange ─
        item1 = _link_and_exchange(client, db)
        items.append(item1)
        row1 = db.one("plaid_items", id=item1)
        assert row1 is not None, "exchange must create a plaid_items row"
        assert row1["user_id"] == USER_ID
        access_token_1 = vault.decrypt(row1["access_token"])
        assert access_token_1.startswith("access-")

        # ── (d)+(e) item 1: cursor-based sync imports ALL sandbox accounts
        #    and their transactions, correctly linked ──────────────────────
        sync.run_sync_for_item(row1["plaid_item_id"], "INITIAL_UPDATE")
        accts1 = _accounts_for(db, item1)
        assert len(accts1) > 1, (
            f"First Platypus Bank should import multiple accounts (cards), got {len(accts1)}"
        )
        txns1 = _transactions_for(db, item1)
        assert txns1, "sync must import transactions for item 1"
        acct_ids1 = {a["id"] for a in accts1}
        assert all(t["account_id"] in acct_ids1 for t in txns1), (
            "every transaction must link to an imported account of the item"
        )
        assert all(t.get("plaid_transaction_id") for t in txns1)

        # ── (f) item 2: the user adds another card — same flow again ───────
        item2 = _link_and_exchange(client, db)
        items.append(item2)
        assert item2 != item1
        row2 = db.one("plaid_items", id=item2)
        assert row2 is not None and row2["user_id"] == USER_ID

        # Exercise the other sync entry point (POST /sync/trigger → run_sync)
        # for the second item.
        sync.run_sync(USER_ID)
        accts2 = _accounts_for(db, item2)
        assert len(accts2) > 1, "second item must also import multiple accounts"
        txns2 = _transactions_for(db, item2)
        assert txns2, "sync must import transactions for item 2"
        assert {a["plaid_account_id"] for a in accts2}.isdisjoint(
            {a["plaid_account_id"] for a in accts1}
        ), "two sandbox items must not share Plaid accounts"

        # ── (g) incremental sync pulls newly posted transactions ─────
        # (The old POST /webhook/plaid event-driven path was removed in the
        # Lambda rebuild; this exercises what the webhook used to trigger —
        # run_sync_for_item with a SYNC_UPDATES code — inline.)
        marker = "E2E WEBHOOK MARKER TXN"
        client.sandbox_transactions_create(
            SandboxTransactionsCreateRequest(
                access_token=access_token_1,
                transactions=[
                    CustomSandboxTransaction(
                        date_transacted=datetime.date(2026, 9, 20),
                        date_posted=datetime.date(2026, 9, 21),
                        amount=12.34,
                        description=marker,
                    )
                ],
            )
        )

        stats = sync.run_sync_for_item(row1["plaid_item_id"], "SYNC_UPDATES_AVAILABLE")
        assert stats["items_synced"] == 1, "item sync must run inline and report"

        pulled = [
            t
            for t in _transactions_for(db, item1)
            if marker in (t.get("description") or "") + (t.get("merchant_name") or "")
        ]
        assert pulled, "incremental sync must pull the newly posted transaction"
        assert all(t["account_id"] in acct_ids1 for t in pulled), (
            "pulled transactions must link to the item's accounts"
        )

    finally:
        # Remove every sandbox item on Plaid's side so nothing counts against
        # the developer account's Item cap; the in-memory DB evaporates.
        for item_uuid in items:
            _remove_item(client, db, item_uuid)
