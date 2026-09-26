import datetime
import json
import logging
import os
import re

from logging_setup import setup_logging

setup_logging()
logger = logging.getLogger('api')
import plaid
from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_request import InstitutionsGetRequest
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_update import LinkTokenCreateRequestUpdate
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from supabase_auth.errors import AuthApiError

import vault
from envutil import _env_float
from plaid_client import (
    credentials_for_user,
    fetch_institution_metadata,
    get_plaid_for_creds,
    get_plaid_for_item,
    invalidate_credentials_cache,
    load_user_credentials,
)
from supabase_client import get_supabase, now_iso
from sync import run_sync, run_sync_for_item

app = FastAPI()

# The web app (browser) calls POST /sync/trigger cross-origin, so it needs CORS.
# The iOS app is native and is unaffected. /link and /onboard are top-level
# navigations or server-to-server, so they don't rely on this. Allowed origins come from
# WEB_ORIGINS (comma-separated) plus localhost dev defaults.
_web_origins = os.environ.get('WEB_ORIGINS', '')
CORS_ORIGINS = [o.strip() for o in _web_origins.split(',') if o.strip()] or [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=['*'],
    allow_headers=['*'],
)

# NOTE: PLAID_WEBHOOK_URL and the POST /webhook/plaid receiver were removed in
# the 2026-09-26 Lambda rebuild (manual refresh only — the user taps refresh in
# the app; there is no scheduler and no webhook listener to drive).

# Cooldown between user-triggered full syncs (POST /backfill-all). A full sync
# re-drains the 730d window for every bank, so it's rate-limited; the quick
# incremental /sync/trigger is never gated.
FULL_SYNC_COOLDOWN_DAYS = _env_float('FULL_SYNC_COOLDOWN_DAYS', 2.0)

# This service's own /link URL, for OAuth banks (Chase, BofA, …). Each BYO user
# must allowlist it in their Plaid dashboard (the onboarding wizard walks them
# through it). Unset = link tokens are created without a redirect_uri, exactly
# as before. On AWS Lambda the deploy worker sets this to the Function URL + /link.
REDIRECT_URI = os.environ.get('PLAID_REDIRECT_URI')  # e.g. https://<id>.lambda-url.us-east-1.on.aws/link


def _user_id_from_token(token: str) -> str:
    """Verify a Supabase access token (JWT) and return its user id, else 401.
    Uses GoTrue /user so we don't need the project JWT secret on the backend.
    A failure to REACH auth is 503 (retryable), not 401 — a token is only
    invalid when the auth service actually rejected it."""
    if not token:
        raise HTTPException(status_code=401, detail='missing access token')
    token = token.removeprefix('Bearer ').strip()
    try:
        resp = get_supabase().auth.get_user(token)
        uid = resp.user.id
    except AuthApiError:
        logger.warning('access token rejected', exc_info=True)
        uid = None
    except Exception:
        logger.warning('auth service unreachable', exc_info=True)
        raise HTTPException(status_code=503, detail='auth service unreachable — try again') from None
    if not uid:
        raise HTTPException(status_code=401, detail='invalid access token')
    return str(uid)


# F15: handlers below are plain `def` (not `async def`) — the Plaid/Supabase
# SDKs are blocking, so Starlette runs `def` handlers in a threadpool instead of
# stalling the single-worker event loop.


def _refresh_user(user_id: str) -> dict:
    """The full manual-refresh chain, run INLINE — no BackgroundTasks.

    On AWS Lambda there is no background worker and no scheduler: the whole
    chain runs inside the Function URL invocation and the caller gets the
    summary back. Keep it under the 15-min Lambda cap — sync.py and
    reconcile.py isolate failures per item, the AI pipeline caps its Brave
    lookups, and the Plaid cursor is checkpointed per page so a truncated run
    resumes where it left off.

    Chain: Plaid transactions/sync per item → reconcile drift healing →
    Jev AI categorization + card-credit auto-detection (inside
    sync._finalize_user / reconcile's finalize) → in-app notifications.
    """
    from notify import run_notify
    from reconcile import run_reconcile

    sync_stats = run_sync(user_id) or {}
    try:
        drift = run_reconcile(user_id) or {}
    except Exception:
        logger.exception('manual refresh: reconcile failed', extra={'user_id': user_id})
        drift = {}
    try:
        notify_stats = run_notify(user_ids={user_id}) or {}
    except Exception:
        logger.exception('manual refresh: notify failed', extra={'user_id': user_id})
        notify_stats = {}

    return {
        'status': 'ok',
        'items_synced': sync_stats.get('items_synced', 0),
        'items_skipped': sync_stats.get('items_skipped', 0),
        'items_failed': sync_stats.get('items_failed', 0),
        'transactions_added': sync_stats.get('transactions_added', 0),
        'transactions_modified': sync_stats.get('transactions_modified', 0),
        'transactions_removed': sync_stats.get('transactions_removed', 0),
        'accounts_updated': sync_stats.get('accounts_updated', 0),
        'categorized': sync_stats.get('categorized', 0),
        'credits_detected': sync_stats.get('credits_detected', 0),
        'drift_healed': {k: drift.get(k, 0) for k in ('missing', 'mismatched', 'stale')},
        'notifications': notify_stats.get('notifications', 0),
    }


@app.post('/sync/trigger')
def trigger_sync(authorization: str = Header(None)):
    # Clients send the user's Supabase JWT → run the whole refresh chain
    # inline and return the summary (this is the ONLY refresh path: no
    # scheduler, no webhooks). Supabase-auth failures surface as 401/503
    # from _user_id_from_token before anything else runs.
    if not authorization:
        raise HTTPException(status_code=401, detail='Unauthorized')
    user_id = _user_id_from_token(authorization)
    return _refresh_user(user_id)


@app.get('/health')
def health():
    return {'status': 'ok'}


# ── Account deletion ─────────────────────────────────────────────────────────

def _plaid_item_remove(supabase, item: dict) -> None:
    """Best-effort Plaid item/remove — invalidate the access token on Plaid's
    side. ITEM_NOT_FOUND (already gone there) and any other Plaid error are
    logged, never fatal: callers still clean up locally. Shared by the per-bank
    unlink and full-account deletion so both sever the connection on Plaid, not
    just in our DB."""
    try:
        plaid_client = get_plaid_for_item(supabase, item)
        access_token = vault.decrypt(item['access_token'])
        plaid_client.item_remove(ItemRemoveRequest(access_token=access_token))
    except Exception:
        logger.warning('Plaid item_remove failed — continuing with local cleanup',
                       exc_info=True,
                       extra={'item_id': item.get('id'),
                              'plaid_item_id': item.get('plaid_item_id')})


@app.delete('/account')
def delete_account(authorization: str = Header(None)):
    """Permanently delete the signed-in user's account and all their data.

    Two steps, in order:
      1. Sever every Plaid connection on Plaid's side (item/remove per active
         item) BEFORE the DB rows go away — deleting the auth user cascades the
         plaid_items rows off, so if we didn't remove them first the access
         tokens would be orphaned and leaked on Plaid, still counting against
         the developer Item cap. This is the clean-break half.
      2. Delete the auth.users row, which cascades to every user-owned table
         (categories, transactions, accounts, budgets, plaid_items, profiles,
         …) via the `on delete cascade` FKs from 20260704000000_multi_user.sql.
         No manual per-table cleanup is needed.

    This is irreversible. The caller must already have confirmed in the UI.
    """
    user_id = _user_id_from_token(authorization)
    supabase = get_supabase()

    # Step 1: invalidate every active Plaid Item on Plaid before the cascade
    # removes our record of them. Best-effort per item (never blocks deletion).
    try:
        items = supabase.table('plaid_items') \
            .select('id, plaid_item_id, access_token, plaid_client_id') \
            .eq('user_id', user_id).eq('is_active', True).execute().data or []
    except Exception:
        items = []
        logger.warning('failed to list plaid_items before account deletion',
                       exc_info=True, extra={'user_id': user_id})
    for item in items:
        _plaid_item_remove(supabase, item)

    # Look up the user's plaid_credentials BEFORE deletion (cascade will remove
    # the row) so we can evict the stale in-memory Plaid client cache afterwards.
    plaid_client_id = None
    try:
        creds_row = supabase.table('plaid_credentials').select('plaid_client_id') \
            .eq('user_id', user_id).limit(1).execute().data
        if creds_row:
            plaid_client_id = creds_row[0]['plaid_client_id']
    except Exception:
        logger.warning('failed to look up plaid_credentials before account deletion',
                       exc_info=True, extra={'user_id': user_id})

    try:
        supabase.auth.admin.delete_user(user_id)
    except Exception as exc:
        logger.error('delete_account failed', exc_info=True,
                     extra={'user_id': user_id})
        raise HTTPException(status_code=500, detail='Failed to delete account') from exc

    # Evict cached Plaid client/credentials so a new user re-using the same
    # plaid_client_id (with a different secret) won't hit a stale client.
    if plaid_client_id:
        invalidate_credentials_cache(plaid_client_id)

    return {'deleted': True}


# ── Per-user Plaid credentials (BYO developer account) ──────────────────

def _mask_client_id(client_id: str) -> str:
    return client_id[:4] + '…' + client_id[-4:] if len(client_id) > 8 else '…'


def _items_in_use(supabase, plaid_client_id: str, house: bool) -> int:
    """Active Items counted against one Plaid developer account's cap.
    Pre-migration house items have plaid_client_id null, so count those too."""
    q = supabase.table('plaid_items').select('id').eq('is_active', True)
    if house:
        q = q.or_(f'plaid_client_id.is.null,plaid_client_id.eq.{plaid_client_id}')
    else:
        q = q.eq('plaid_client_id', plaid_client_id)
    return len(q.execute().data)


def _credentials_status(supabase, user_id: str) -> dict:
    creds = load_user_credentials(supabase, user_id)
    if not creds:
        return {'configured': False}
    return {
        'configured': True,
        'client_id_masked': _mask_client_id(creds['plaid_client_id']),
        'env': creds['env'],
        'items_used': _items_in_use(supabase, creds['plaid_client_id'], house=False),
        'item_limit': creds['item_limit'],
    }


@app.get('/credentials')
def credentials_status(authorization: str = Header(None)):
    user_id = _user_id_from_token(authorization)
    return _credentials_status(get_supabase(), user_id)


# Plaid dashboard key formats: client_id is 24 hex chars, secrets are 30.
_CLIENT_ID_RE = re.compile(r'\b[a-f0-9]{24}\b')
_SECRET_RE = re.compile(r'\b[a-f0-9]{30}\b')


def _extract_plaid_keys(raw: str):
    """(client_ids, secrets) found in arbitrary text pasted off the Plaid
    dashboard API-keys page. The page shows one client_id but a secret per
    environment, so multiple secret candidates are normal — the caller probes
    each against the requested env."""
    return (list(dict.fromkeys(_CLIENT_ID_RE.findall(raw))),
            list(dict.fromkeys(_SECRET_RE.findall(raw))))


def _probe(client_id: str, secret: str, env: str):
    """Try a cheap read-only Plaid call with these credentials.
    None on success, else (error_code, display_message)."""
    client = get_plaid_for_creds({'plaid_client_id': client_id, 'secret': secret, 'env': env})
    try:
        client.institutions_get(InstitutionsGetRequest(
            count=1, offset=0, country_codes=[CountryCode('US'), CountryCode('CA')],
        ))
        return None
    except plaid.ApiException as e:
        invalidate_credentials_cache(client_id)   # don't cache a client built on bad creds
        try:
            body = json.loads(e.body)
            code = body.get('error_code') or 'UNKNOWN'
            message = body.get('display_message') or body.get('error_message') or ''
        except Exception:
            code, message = 'UNKNOWN', ''
        logger.warning('Plaid credential probe failed',
                       extra={'plaid_env': env, 'plaid_error_code': code})
        return code, message
    except Exception:
        invalidate_credentials_cache(client_id)
        logger.warning('Plaid credential probe failed', exc_info=True,
                       extra={'plaid_env': env})
        return 'UNKNOWN', ''


def _credential_error_detail(client_id: str, candidates: list, env: str, err) -> str:
    """A specific, actionable message for a failed credential save. The most
    common mistake is pasting the other environment's secret — detect it by
    probing the same candidates against the other env."""
    code, message = err
    if code == 'INVALID_API_KEYS':
        other = 'sandbox' if env == 'production' else 'production'
        if any(_probe(client_id, cand, other) is None for cand in candidates):
            return (f"That secret is for {other}, not {env} — copy the "
                    f"{env.capitalize()} secret from the API keys page and try again.")
        return ('Plaid did not recognize this client ID + secret. Double-check both on '
                'dashboard.plaid.com → Developers → API keys, and make sure your Plaid '
                f'account has {env.capitalize()} access.')
    detail = f'Plaid rejected these credentials ({code})'
    return f'{detail}: {message}' if message else detail


@app.post('/credentials')
def save_credentials(payload: dict = Body(...), authorization: str = Header(None)):
    user_id = _user_id_from_token(authorization)
    env = (payload.get('env') or 'production').strip()
    if env not in ('sandbox', 'production'):
        raise HTTPException(status_code=400, detail="env must be 'sandbox' or 'production'")

    raw = (payload.get('raw') or '').strip()
    if raw:
        # Paste-anything mode (onboarding wizard): pull the keys out of whatever
        # was copied off the Plaid dashboard.
        client_ids, candidates = _extract_plaid_keys(raw)
        if not client_ids:
            raise HTTPException(status_code=400, detail=(
                "Couldn't find a client ID (24-character code) in the pasted text — "
                'copy the whole API keys page and paste it here.'))
        if len(client_ids) > 1:
            raise HTTPException(status_code=400, detail=(
                'Found more than one possible client ID — paste just your API keys page.'))
        if not candidates:
            raise HTTPException(status_code=400, detail=(
                "Couldn't find a secret (30-character code) in the pasted text — "
                'reveal the secret on the API keys page, then copy and paste again.'))
        client_id = client_ids[0]
    else:
        client_id = (payload.get('client_id') or '').strip()
        secret = (payload.get('secret') or '').strip()
        if not client_id or not secret:
            raise HTTPException(status_code=400, detail='client_id and secret are required')
        candidates = [secret]

    # Prove the credentials work before storing them: probe each candidate
    # secret (the keys page shows one per environment) and keep the first
    # that Plaid accepts for the requested env.
    secret, first_err = None, None
    for cand in candidates[:3]:
        err = _probe(client_id, cand, env)
        if err is None:
            secret = cand
            break
        first_err = first_err or err
    if secret is None:
        detail = _credential_error_detail(client_id, candidates[:3], env, first_err)
        invalidate_credentials_cache(client_id)
        raise HTTPException(status_code=400, detail=detail)

    supabase = get_supabase()
    supabase.table('plaid_credentials').upsert({
        'user_id': user_id,
        'plaid_client_id': client_id,
        'plaid_secret_enc': vault.encrypt(secret),
        'plaid_env': env,
        'is_active': True,
        'updated_at': now_iso(),
    }, on_conflict='user_id').execute()
    invalidate_credentials_cache(client_id)

    return _credentials_status(supabase, user_id)


@app.delete('/credentials')
def delete_credentials(authorization: str = Header(None)):
    user_id = _user_id_from_token(authorization)
    supabase = get_supabase()
    creds = load_user_credentials(supabase, user_id)
    if not creds:
        return {'configured': False}
    in_use = _items_in_use(supabase, creds['plaid_client_id'], house=False)
    if in_use:
        raise HTTPException(
            status_code=409,
            detail=f'{in_use} linked bank(s) still use these credentials — unlink them first',
        )
    supabase.table('plaid_credentials').delete().eq('user_id', user_id).execute()
    invalidate_credentials_cache(creds['plaid_client_id'])
    return {'configured': False}


# ── Plaid Link (in-app "add bank account") ──────────────────────────────

_HOSTED_HEADERS = {'Referrer-Policy': 'no-referrer'}


def _hosted_html(html: str, status_code: int = 200) -> HTMLResponse:
    # Backend-hosted pages carry the Supabase JWT in the URL fragment;
    # no-referrer keeps even the non-fragment part of the URL out of any Referer
    # sent to Plaid's CDN / Google Fonts. Belt-and-suspenders with the in-page
    # <meta name="referrer"> (which also covers browsers that ignore the header).
    return HTMLResponse(html, status_code=status_code, headers=_HOSTED_HEADERS)


@app.get('/link', response_class=HTMLResponse)
def link_page():
    # Static shell. The Supabase JWT arrives in the URL *fragment*
    # (#access_token=…) — which the browser never sends to the server or leaks
    # via proxy logs / Referer — so the page's JS reads it and calls
    # POST /link/prepare to mint the Plaid Link token. OAuth banks bounce back
    # with only ?oauth_state_id=… and resume the stashed token from
    # sessionStorage; that path is handled in the shell too.
    return _hosted_html(_LINK_HTML)


@app.post('/link/prepare')
def link_prepare(authorization: str = Header(None), payload: dict = Body(default=None)):
    """Mint a Plaid Link token for the signed-in user.

    Split out of GET /link so the Supabase JWT can travel in the URL fragment
    and reach us in the Authorization header instead of a loggable query param.
    Returns the link token, or a status the shell renders inline:
    `no_creds` (user hasn't added Plaid keys yet) or `limit` (item cap hit).

    Update Mode: when `item_id` (the plaid_items UUID) is passed in the body,
    the endpoint looks up the item's encrypted access_token and passes it to
    link_token_create. Plaid opens in Update Mode — the user re-authenticates
    the same institution without creating a new Item (no quota burned). The
    frontend skips calling /link/exchange on success."""
    user_id = _user_id_from_token(authorization)
    supabase = get_supabase()
    creds = credentials_for_user(supabase, user_id)
    if creds is None:
        return {'status': 'no_creds'}

    body = payload if isinstance(payload, dict) else {}
    item_id = body.get('item_id')

    # ── Update Mode: re-authenticate the user's own item ─────────────────
    if item_id:
        # Re-auth of an existing item the user owns (e.g. the bank forced a
        # re-login) — opens Plaid Link in Update Mode against the stored
        # access_token, no new Item created.
        row = supabase.table('plaid_items').select('access_token, plaid_client_id, user_id') \
            .eq('id', item_id).single().execute().data
        if not row:
            raise HTTPException(status_code=404, detail='Item not found')
        # Only the owner may re-authenticate the item.
        if row['user_id'] != user_id:
            raise HTTPException(status_code=403, detail='Item belongs to another user')
        if row['plaid_client_id'] != creds['plaid_client_id']:
            raise HTTPException(status_code=403, detail='Item belongs to a different Plaid account')

        access_token = vault.decrypt(row['access_token'])
        client = get_plaid_for_creds(creds)
        kwargs = dict(
            user=LinkTokenCreateRequestUser(client_user_id=user_id),
            client_name='My Finance App',
            country_codes=[CountryCode('US'), CountryCode('CA')],
            language='en',
            access_token=access_token,
            # Let the user tick accounts the institution added *after* the
            # original link (a new credit card, a new savings account). Plaid
            # never adds accounts to an existing Item on its own — without this
            # flag Update Mode only repairs credentials, and the new account's
            # transactions are never fetched. /link/claim then resets the
            # cursor so the next sync pulls the new account's history.
            update=LinkTokenCreateRequestUpdate(account_selection_enabled=True),
            # Same history window as a fresh link; applies to accounts added
            # through this Update Mode session.
            transactions=LinkTokenTransactions(days_requested=730),
            # Consent to Investments without adding it to `products`: the subscription only
            # bills when we actually call /investments/transactions/get, i.e. for
            # items that have a brokerage account — not every linked bank.
            additional_consented_products=[Products('investments')],
        )
        if REDIRECT_URI:
            kwargs['redirect_uri'] = REDIRECT_URI
        try:
            link_token = client.link_token_create(LinkTokenCreateRequest(**kwargs)).to_dict()['link_token']
        except Exception:
            # Plaid rejects the access_token — most likely the secret was
            # rotated (new team/app under the same client_id). The item is
            # unrecoverable; invalidate it on Plaid (best-effort) and drop the
            # row so it stops appearing.
            logger.warning('Update Mode link_token_create failed — item %s '
                           'is unrecoverable (secret rotated?)', item_id, exc_info=True)
            _plaid_item_remove(supabase, {'id': item_id, 'access_token': row['access_token'],
                                          'plaid_client_id': row['plaid_client_id']})
            supabase.table('plaid_items').delete().eq('id', item_id).execute()
            return {'status': 'expired', 'detail': 'This connection can no longer be '
                    'restored — it may have been invalidated by a Plaid credential '
                    'change. Please link the bank again as a new connection.'}
        return {'status': 'ok', 'link_token': link_token, 'mode': 'update', 'item_id': item_id}

    # ── Normal Mode: fresh link ──────────────────────────────────────────
    used = _items_in_use(supabase, creds['plaid_client_id'], house=creds['source'] == 'house')
    if used >= creds['item_limit']:
        return {'status': 'limit', 'used': used, 'limit': creds['item_limit']}

    client = get_plaid_for_creds(creds)
    kwargs = dict(
        user=LinkTokenCreateRequestUser(client_user_id=user_id),
        client_name='My Finance App',
        products=[Products('transactions')],
        country_codes=[CountryCode('US'), CountryCode('CA')],
        language='en',
        # Max history Plaid allows; default is only 90 days. Applies per-item at
        # link time, so already-linked items keep their original window.
        transactions=LinkTokenTransactions(days_requested=730),
        # Consent to Investments without adding it to `products`: the subscription only
        # bills when we actually call /investments/transactions/get, i.e. for
        # items that have a brokerage account — not every linked bank.
        additional_consented_products=[Products('investments')],
    )
    if REDIRECT_URI:
        kwargs['redirect_uri'] = REDIRECT_URI
    try:
        link_token = client.link_token_create(LinkTokenCreateRequest(**kwargs)).to_dict()['link_token']
    except plaid.ApiException as e:
        # Plaid refused to mint the token. Uncaught, this escapes as a bare 500 -
        # and FastAPI returns 500s WITHOUT the CORS headers, so the browser
        # reports "Failed to fetch" and the /link page can only say "Something
        # went wrong". Returning 200 with a status keeps it inside CORS and lets
        # the page show what Plaid actually objected to. Same shape as the
        # credential probe above.
        try:
            body = json.loads(e.body)
            code = body.get('error_code') or 'UNKNOWN'
            message = body.get('display_message') or body.get('error_message') or ''
        except Exception:
            code, message = 'UNKNOWN', (e.body or '')[:300]
        logger.warning('link_token_create rejected by Plaid',
                       extra={'plaid_error_code': code, 'plaid_error_message': message})
        return {'status': 'plaid_error', 'code': code, 'detail': message}
    return {'status': 'ok', 'link_token': link_token}


# Static shell served for every load of /link. Two entry paths, both resolved
# client-side: the first load reads the Supabase JWT from the URL fragment and
# calls POST /link/prepare for a fresh Plaid Link token (stashing both in
# sessionStorage); the OAuth redirect return (?oauth_state_id=…, no token in the
# URL) resumes with the SAME token read back from sessionStorage.
_LINK_HTML = """<!DOCTYPE html>
<html>
<head>
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Add Bank</title>
  <style>body{font-family:-apple-system,sans-serif;text-align:center;padding:40px}</style>
</head>
<body>
<h2>Connecting…</h2>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const OAUTH_RESUME = new URLSearchParams(window.location.search).has('oauth_state_id');

function show(html) { document.body.innerHTML = html; }
function expired() {
    show('<h2>Session expired</h2><p>Go back to the app and tap “Add bank account” again.</p>');
}

function openPlaid(linkToken, accessToken, mode, itemId) {
    const config = {
        token: linkToken,
        onSuccess: function(public_token, metadata) {
            if (mode === 'update') {
                // Update Mode: no new access_token issued — claim the orphaned item.
                fetch('/link/claim', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ item_id: itemId, access_token: accessToken })
                }).then(r => r.json()).then(data => {
                    sessionStorage.setItem('plaid_link_result', JSON.stringify(data));
                    if (window.opener) {
                        try { window.opener.postMessage({ type: 'PLAID_LINK_SUCCESS', data: data }, '*'); } catch(e) {}
                    }
                    show('<h2>✅ Reconnected ' + (data.institution || 'account') + '</h2><p>You can close this window.</p>');
                });
            } else {
                fetch('/link/exchange', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ public_token, metadata, access_token: accessToken })
                }).then(r => r.json()).then(data => {
                    // Persist for iOS (SafariView reads sessionStorage on dismiss) and
                    // for the web opener window polling.
                    sessionStorage.setItem('plaid_link_result', JSON.stringify(data));
                    // Notify the opener window (web tab scenario).
                    if (window.opener) {
                        try { window.opener.postMessage({ type: 'PLAID_LINK_SUCCESS', data: data }, '*'); } catch(e) {}
                    }
                    show('<h2>✅ Linked ' + (data.institution || 'account') + '</h2><p>You can close this window.</p>');
                });
            }
        },
        onExit: function(err) { show('<h2>Cancelled.</h2><p>You can close this window.</p>'); }
    };
    if (OAUTH_RESUME) config.receivedRedirectUri = window.location.href;
    Plaid.create(config).open();
}

// Ask the backend (authenticated by the fragment token, sent as a header) for a
// fresh Link token. Retries transient auth-service outages (503).
// When itemId is set, the backend mints an Update Mode token (reconnect).
function prepare(accessToken, itemId) {
    const opts = {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken }
    };
    if (itemId) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify({ item_id: itemId });
    }
    fetch('/link/prepare', opts).then(async (r) => {
        if (r.status === 401) return expired();
        if (r.status === 503) { setTimeout(() => prepare(accessToken, itemId), 2000); return; }
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return show('<h2>Something went wrong</h2><p>Please try again from the app.</p>');
        if (data.status === 'no_creds') {
            const onboard = '/onboard#access_token=' + encodeURIComponent(accessToken);
            show("<h2>Set up bank connections</h2>"
                + "<p>You need a free Plaid developer account before you can link banks — "
                + "guided setup takes about 15 minutes.</p>"
                + "<p><a href='" + onboard + "' style='display:inline-block;background:#893217;"
                + "color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;"
                + "font-weight:600'>Start guided setup</a></p>");
        } else if (data.status === 'limit') {
            show('<h2>Item limit reached</h2><p>This Plaid account already has ' + data.used
                + ' of ' + data.limit + ' linked banks. Unlink one, or upgrade the Plaid plan.</p>');
        } else if (data.status === 'plaid_error') {
            const esc = (t) => String(t == null ? '' : t)
                .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            show('<h2>Plaid refused this request</h2>'
                + '<p>Nothing is wrong with your bank - Plaid rejected the setup.</p>'
                + '<p style="display:inline-block;text-align:left;max-width:560px;'
                + 'background:#f6f6f6;border-radius:8px;padding:14px 16px;font-family:monospace;'
                + 'font-size:13px;line-height:1.5">' + esc(data.code) + '<br>' + esc(data.detail)
                + '</p>');
        } else if (data.status === 'expired') {
            show('<h2>Connection expired</h2><p>' + (data.detail || 'This connection can no longer be restored. Please link the bank again as a new connection.') + '</p>');
        } else {
            sessionStorage.setItem('plaid_link_token', data.link_token);
            sessionStorage.setItem('plaid_access_token', accessToken);
            sessionStorage.setItem('plaid_link_mode', data.mode || 'normal');
            sessionStorage.setItem('plaid_link_item_id', data.item_id || '');
            openPlaid(data.link_token, accessToken, data.mode || 'normal', data.item_id || '');
        }
    }).catch(() => show('<h2>Network error</h2><p>Please try again from the app.</p>'));
}

if (OAUTH_RESUME) {
    const linkToken = sessionStorage.getItem('plaid_link_token');
    const accessToken = sessionStorage.getItem('plaid_access_token');
    const mode = sessionStorage.getItem('plaid_link_mode') || 'normal';
    const itemId = sessionStorage.getItem('plaid_link_item_id') || '';
    if (!linkToken) expired(); else openPlaid(linkToken, accessToken, mode, itemId);
} else {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = params.get('access_token');
    const itemId = params.get('item_id') || '';
    if (!accessToken) {
        expired();
    } else {
        // Drop the token from the address bar / this history entry right away;
        // it's captured in `accessToken` for the calls above.
        history.replaceState(null, '', window.location.pathname);
        prepare(accessToken, itemId);
    }
}
</script>
</body>
</html>"""


@app.post('/link/exchange')
def link_exchange(payload: dict = Body(...)):
    user_id = _user_id_from_token(payload.get('access_token', ''))
    metadata = payload.get('metadata', {}) or {}

    # Must exchange with the same Plaid account that created the link token
    # (the linking user's own creds, or house).
    supabase = get_supabase()
    creds = credentials_for_user(supabase, user_id)
    if creds is None:
        raise HTTPException(status_code=400, detail='no Plaid credentials configured for this user')
    plaid = get_plaid_for_creds(creds)
    exchange = plaid.item_public_token_exchange(
        ItemPublicTokenExchangeRequest(public_token=payload['public_token'])
    ).to_dict()

    institution = metadata.get('institution', {}) or {}
    supabase.table('plaid_items').upsert({
        'user_id': user_id,
        'plaid_item_id': exchange['item_id'],
        'access_token': vault.encrypt(exchange['access_token']),
        'plaid_client_id': creds['plaid_client_id'],
        'institution_id': institution.get('institution_id'),
        'institution_name': institution.get('name', 'Unknown'),
        **fetch_institution_metadata(plaid, institution.get('institution_id')),
    }, on_conflict='plaid_item_id').execute()

    # Fetch the row we just upserted to get its UUID.
    row = supabase.table('plaid_items') \
        .select('id') \
        .eq('plaid_item_id', exchange['item_id']) \
        .single() \
        .execute().data

    return JSONResponse({
        'institution': institution.get('name', 'account'),
        'item_id': str(row['id']),
        'new_account': True,
    })


@app.post('/link/claim')
def link_claim(payload: dict = Body(...)):
    """Plaid update-mode (reconnect) success. Unlike /link/exchange there is no
    new public_token — the item's access_token is unchanged; the user re-authed
    to repair credentials or grant a newly requested product (investments). Verify ownership, then run a full re-pull inline so any
    newly-consented product ingests the history it couldn't serve before (e.g.
    investment cash movements). Returns the institution name for the shell's
    success banner plus the sync stats."""
    user_id = _user_id_from_token(payload.get('access_token', ''))
    item_id = payload.get('item_id')
    if not item_id:
        raise HTTPException(status_code=400, detail='item_id required')

    supabase = get_supabase()
    rows = (
        supabase.table('plaid_items')
        .select('id, plaid_item_id, institution_name')
        .eq('id', item_id)
        .eq('user_id', user_id)
        .eq('is_active', True)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        raise HTTPException(status_code=404, detail='item not found')

    # No token to exchange — the item is unchanged. Clearing the cursor forces
    # the next sync to re-pull the full window so a freshly consented product
    # (e.g. investments) backfills the history it couldn't return before.
    supabase.table('plaid_items').update({
        'cursor': None,
        'backfill_requested': True,
    }).eq('id', item_id).execute()

    logger.info('item reconnected (update mode); backfill kicked',
                extra={'item_id': item_id, 'user_id': user_id})
    sync_stats = run_sync_for_item(rows[0]['plaid_item_id'], 'HISTORICAL_UPDATE') or {}
    return JSONResponse({
        'institution': rows[0].get('institution_name') or 'account',
        'item_id': str(rows[0]['id']),
        'sync': sync_stats,
    })


@app.post('/backfill/{item_id}')
def request_backfill(item_id: str, authorization: str = Header(None)):
    """Reset the Plaid cursor for an item so the next sync re-fetches full
    history (up to the 730-day window set at link time), then run that sync
    INLINE and return its stats. The UI calls this immediately after linking a
    new bank when the user chooses "Full history"."""
    user_id = _user_id_from_token(authorization)
    supabase = get_supabase()

    # Verify ownership and that the item exists.
    rows = (
        supabase.table('plaid_items')
        .select('id, plaid_item_id')
        .eq('id', item_id)
        .eq('user_id', user_id)
        .eq('is_active', True)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        raise HTTPException(status_code=404, detail='item not found')

    plaid_item_id = rows[0]['plaid_item_id']

    # Clearing the cursor forces the next sync to start from the beginning,
    # pulling the full 730-day window Plaid allows for this item.
    supabase.table('plaid_items').update({
        'cursor': None,
        'backfill_requested': True,
    }).eq('id', item_id).execute()

    # Run the sync inline (no background worker on Lambda) and return its
    # stats; a >15-min backfill resumes from the checkpointed cursor because
    # _sync_item_locked writes the cursor after every page.
    sync_stats = run_sync_for_item(plaid_item_id, 'HISTORICAL_UPDATE') or {}

    logger.info('backfill requested', extra={'item_id': item_id, 'user_id': user_id})
    return {'status': 'ok', 'sync': sync_stats}


@app.post('/credits/detect')
def detect_credits(authorization: str = Header(None)):
    """Re-run card-credit auto-detection for the signed-in user.

    Plaid syncs already run it via _finalize_user, but CSV import
    inserts transactions via PostgREST from the web app — bypassing the
    backend — so the app calls this endpoint after a CSV import to catch
    newly-imported statement credits."""
    from credit_detector import detect_credit_usage
    user_id = _user_id_from_token(authorization)
    try:
        stats = detect_credit_usage(get_supabase(), user_id)
    except Exception:
        logger.exception('credit detection failed', extra={'user_id': user_id})
        raise HTTPException(status_code=500, detail='credit detection failed') from None
    return {'detected': stats['detected'], 'credits': stats['credits']}


@app.post('/categorize/auto')
def auto_categorize(authorization: str = Header(None)):
    """Run the AI categorization pipeline for the signed-in user.

    Plaid syncs already run it via _finalize_user, but CSV import
    inserts transactions via PostgREST from the web app — bypassing the
    backend — so the app calls this after a CSV import (and the Transactions
    "Auto-categorize" button calls it on demand). Rules + merchant memory
    always run first; the AI provider only sees what they couldn't classify.
    Returns the pipeline stats dict."""
    from ai_categorize.pipeline import run_ai_categorization
    user_id = _user_id_from_token(authorization)
    try:
        stats = run_ai_categorization(get_supabase(), user_id)
    except Exception:
        logger.exception('ai categorization failed', extra={'user_id': user_id})
        raise HTTPException(status_code=500, detail='categorization failed') from None
    return stats


@app.get('/categorize/status')
def categorize_status(authorization: str = Header(None)):
    """AI categorization status for the Settings page: user prefs plus
    *presence* (never values) of the backend API keys. Keys stay in env."""
    import os

    from ai_categorize.merchant_search import brave_api_key
    from ai_categorize.providers import jev_api_key
    user_id = _user_id_from_token(authorization)
    try:
        rows = get_supabase().table('profiles') \
            .select('ai_enabled, ai_provider, ai_confidence_threshold') \
            .eq('id', user_id).execute().data or []
        prof = rows[0] if rows else {}
    except Exception:
        logger.exception('categorize status failed', extra={'user_id': user_id})
        prof = {}
    provider = (prof.get('ai_provider')
                or os.environ.get('AI_CLASSIFIER_PROVIDER') or 'jev')
    return {
        'ai_enabled': prof.get('ai_enabled', True),
        'ai_provider': provider,
        'ai_confidence_threshold': prof.get('ai_confidence_threshold', 0.7),
        'jev_key_configured': bool(jev_api_key()),
        'brave_key_configured': bool(brave_api_key()),
    }


@app.post('/backfill-all')
def request_backfill_all(authorization: str = Header(None)):
    """Full sync: reset every active item's cursor so the next sync re-pulls the
    full 730-day window for all of the user's linked banks, then run the full
    manual-refresh chain INLINE (Plaid sync → reconcile → AI categorization →
    credit detection → notifications) and return its summary. Heavier than the
    incremental /sync/trigger (which only fetches cursor deltas), so it's
    rate-limited to once per FULL_SYNC_COOLDOWN_DAYS. Powers the Settings
    "Full sync" button. Returns {status:'ok', ...} or 429 {status:'cooldown', next_at}."""
    user_id = _user_id_from_token(authorization)
    supabase = get_supabase()

    items = supabase.table('plaid_items') \
        .select('id, last_backfill_at') \
        .eq('user_id', user_id).eq('is_active', True).execute().data
    if not items:
        raise HTTPException(status_code=404, detail='no linked banks to sync')

    # Cooldown: the newest last_backfill_at across the user's items is their last
    # full sync. Block another until the window elapses.
    now = datetime.datetime.now(datetime.UTC)
    stamps = [i['last_backfill_at'] for i in items if i.get('last_backfill_at')]
    if stamps:
        next_at = datetime.datetime.fromisoformat(max(stamps)) \
            + datetime.timedelta(days=FULL_SYNC_COOLDOWN_DAYS)
        if now < next_at:
            logger.info('full backfill on cooldown', extra={'user_id': user_id})
            return JSONResponse(status_code=429, content={
                'status': 'cooldown', 'next_at': next_at.isoformat(),
            })

    supabase.table('plaid_items').update({
        'cursor': None,
        'backfill_requested': True,
        'last_backfill_at': now.isoformat(),
    }).eq('user_id', user_id).eq('is_active', True).execute()

    # One run_sync covers every item this user owns; sync_item honours
    # backfill_requested to reset the cursor even if a sync races the flag.
    # Run the full refresh chain inline (no background worker on Lambda) and
    # merge the summary into the response.
    summary = _refresh_user(user_id)
    summary['items'] = len(items)

    logger.info('full backfill requested',
                extra={'user_id': user_id, 'items': len(items)})
    return summary


@app.delete('/items/{item_id}')
def delete_item(item_id: str, authorization: str = Header(None)):
    """Unlink a Plaid item: call Plaid item/remove, delete all associated
    transactions and accounts, then mark the item inactive.

    Deletes in dependency order:
      1. transactions  (FK → account_id)
      2. accounts      (FK → item_id)
      3. plaid_items   (soft-delete: is_active = False)

    Plaid's item/remove is called first so the access token is invalidated on
    their side before we touch our data. A Plaid-side error is logged but not
    fatal — we still clean up locally so the user's UI reflects the removal.
    """
    user_id = _user_id_from_token(authorization)
    supabase = get_supabase()

    # Ownership check — only the item owner can delete it, and it must be active.
    rows = (
        supabase.table('plaid_items')
        .select('id, plaid_item_id, access_token, plaid_client_id')
        .eq('id', item_id)
        .eq('user_id', user_id)
        .eq('is_active', True)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        raise HTTPException(status_code=404, detail='item not found')

    item = rows[0]

    # 1. Tell Plaid to invalidate the access token (best-effort — see helper).
    _plaid_item_remove(supabase, item)

    # 2. Fetch the account IDs for this item (need them for the transactions delete).
    account_rows = (
        supabase.table('accounts')
        .select('id')
        .eq('plaid_item_id', item_id)
        .execute()
        .data
    )
    account_ids = [r['id'] for r in account_rows]

    # 3. Delete all transactions belonging to this item's accounts.
    if account_ids:
        supabase.table('transactions').delete().in_('account_id', account_ids).execute()

    # 4. Delete the accounts themselves.
    supabase.table('accounts').delete().eq('plaid_item_id', item_id).execute()

    # 5. Soft-delete the item so it no longer appears in any active-item queries.
    supabase.table('plaid_items').update({'is_active': False}).eq('id', item_id).execute()

    # 6. Evict cached Plaid client for this client_id so stale credentials
    #    aren't reused if the same client_id is later paired with a new secret.
    if item.get('plaid_client_id'):
        invalidate_credentials_cache(item['plaid_client_id'])

    logger.info(
        'item deleted',
        extra={
            'item_id': item_id,
            'user_id': user_id,
            'accounts_deleted': len(account_ids),
        },
    )
    return {'status': 'ok'}


# ── Guided onboarding wizard (BYO Plaid developer account) ──────────────
#
# One backend-hosted page used by both clients (iOS opens it in a Safari view,
# web opens it in a new tab) — the same pattern as /link. Walks a new user
# through creating a free Plaid account, pasting their keys, allowlisting the
# OAuth redirect URI, and linking a first bank. There is no Plaid provisioning
# API, so the dashboard steps stay manual — the wizard supplies exact answers
# and deep links, and the paste box accepts the whole keys page.

@app.get('/onboard', response_class=HTMLResponse)
def onboard_page():
    # Static shell. The Supabase JWT arrives in the URL fragment; the
    # page's JS reads it and fetches GET /credentials (Authorization header) for
    # the setup status. Auth failures (expired session, auth-service outage) are
    # rendered client-side from that fetch. REDIRECT_URI is non-sensitive
    # deployment config, safe to inline.
    return _hosted_html(_ONBOARD_HTML.replace('__REDIRECT_URI__', json.dumps(REDIRECT_URI)))


_ONBOARD_HTML = """<!DOCTYPE html>
<html>
<head>
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect your banks</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    /* Palette mirrors the "Terracotta & Sage" design system
       (web/src/index.css · PocketLens/Components/Theme.swift), both modes. */
    :root { color-scheme: light dark;
      --accent: #893217; --accent-fg: #ffffff; --accent-hover: #a8492c;
      --ok: #376847;
      --bg: #FAF5F0; --surface: #FFFFFF; --text: #221a15; --text-2: #56423d;
      --line: #EBE2D8; --fill: #fbebe2;
      --error: #ba1a1a;
      --card-shadow: 0 4px 20px rgba(36, 28, 23, 0.06); }
    @media (prefers-color-scheme: dark) { :root {
      --accent: #FFB59F; --accent-fg: #561F0A; --accent-hover: #ffc7b5;
      --ok: #9DD3AA;
      --bg: #1A120D; --surface: #221A15; --text: #F5E5DD; --text-2: #DCC0B9;
      --line: #56423d; --fill: #2c221c;
      --error: #FFB4AB;
      --card-shadow: 0 4px 20px rgba(0, 0, 0, 0.28); } }
    body { font-family: 'Inter', -apple-system, system-ui, sans-serif; margin: 0 auto;
           max-width: 640px; padding: 24px 16px 48px; line-height: 1.45;
           -webkit-font-smoothing: antialiased;
           background: var(--bg); color: var(--text); }
    h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 4px; }
    .sub { color: var(--text-2); margin: 0 0 20px; font-size: 15px; }
    .banner { background: color-mix(in srgb, var(--ok) 12%, transparent);
              border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent);
              border-radius: 12px; padding: 10px 14px; margin-bottom: 16px; font-size: 14px; }
    /* Borderless soft-shadow card, per the design-system card recipe. */
    .step { border-radius: 16px; margin-bottom: 12px; overflow: hidden;
            background: var(--surface); box-shadow: var(--card-shadow); }
    .step-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px;
                 cursor: pointer; font-weight: 600; }
    .step.open .step-head { border-bottom: 1px solid var(--line); }
    .step-num { width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: var(--accent-fg);
                display: flex; align-items: center; justify-content: center; font-size: 13px;
                font-weight: 600; flex-shrink: 0; }
    .step.done .step-num { background: var(--ok); color: #fff; }
    .step.done .step-num::before { content: "✓"; }
    .step.done .step-num span { display: none; }
    .step-body { display: none; padding: 12px 16px 18px; font-size: 15px; }
    .step.open .step-body { display: block; }
    /* Filled terracotta pill, matching the primary-button recipe. */
    a.btn, button.btn { display: inline-block; background: var(--accent); color: var(--accent-fg); border: 0;
        padding: 11px 20px; border-radius: 999px; text-decoration: none; font-weight: 600;
        font-size: 15px; font-family: inherit; cursor: pointer; margin: 6px 8px 2px 0;
        transition: background .15s ease, transform .1s ease; }
    a.btn:hover, button.btn:hover { background: var(--accent-hover); }
    a.btn:active, button.btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.6; cursor: default; }
    a.ext { color: var(--accent); font-weight: 600; }
    button.ghost { background: none; border: 0; color: var(--accent); font-weight: 600;
        font-size: 15px; font-family: inherit; cursor: pointer; padding: 10px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 8px 0; }
    td { border-top: 1px solid var(--line); padding: 6px 8px 6px 0;
         vertical-align: top; }
    td:first-child { color: var(--text-2); white-space: nowrap; padding-right: 14px; }
    .copyrow { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
    .copyrow code { flex: 1; overflow-x: auto; white-space: nowrap; padding: 8px 10px;
        background: var(--fill); border-radius: 8px; font-size: 13px; }
    .copyrow button { flex-shrink: 0; }
    textarea { width: 100%; box-sizing: border-box; min-height: 96px; border-radius: 12px;
        border: 1px solid var(--line); background: var(--surface); color: var(--text);
        padding: 10px; font-size: 14px;
        font-family: ui-monospace, monospace; }
    textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent);
        outline-offset: 1px; border-color: var(--accent); }
    .error { color: var(--error); font-size: 14px; margin: 8px 0 0; display: none; }
    .fine { color: var(--text-2); font-size: 13px; margin-top: 10px; }
    .meter { font-weight: 600; }
    footer { color: var(--text-2); font-size: 13px; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>Connect your banks</h1>
  <p class="sub">One-time setup, about 15 minutes. Free — no credit card.</p>
  <div class="banner" id="banner" style="display:none"></div>

  <div class="step" id="step1">
    <div class="step-head" onclick="setStep(1)"><div class="step-num"><span>1</span></div>
      Create your free Plaid account</div>
    <div class="step-body">
      <p>Plaid is the service that securely connects your banks. The free plan covers
         10 linked banks — plenty. Sign up (Google sign-in works), then answer like this:</p>
      <table>
        <tr><td>Account type</td><td>“Personal use — I want to use Plaid's APIs to build
            something for fun”</td></tr>
        <tr><td>Create new team → Use&nbsp;case</td><td>“Personal finances”</td></tr>
        <tr><td>Team&nbsp;name (if asked)</td><td>Your own full name</td></tr>
      </table>
      <a class="btn" href="https://dashboard.plaid.com/signup" target="_blank" rel="noopener">Open Plaid signup</a>
      <button class="ghost" onclick="setStep(2)">I have a Plaid account →</button>
    </div>
  </div>

  <div class="step" id="step2">
    <div class="step-head" onclick="setStep(2)"><div class="step-num"><span>2</span></div>
      Request Production access</div>
    <div class="step-body">
      <p>On <a class="ext" href="https://dashboard.plaid.com/" target="_blank"
            rel="noopener">your Plaid dashboard</a>, hit <b>Try for free</b> on the
         “Free trial” banner (or <b>Get production access</b> in the sidebar). The
         “Request production access” wizard assumes you're a company — you're a company
         of one. Answer like this:</p>
      <table>
        <tr><td>Business type &amp; details</td><td>Personal / individual use ·
            “Fewer than 1,000 employees” · data accessed and stored in your own country ·
            “No, we do not sell consumer data” · no data breach</td></tr>
        <tr><td>Industry</td><td>“Other (please describe)” → type “Hobby project”</td></tr>
        <tr><td>App details</td><td>Any app name plus your own email. This part is public
            (banks show it when you connect); icon and brand color are optional</td></tr>
        <tr><td>Products</td><td>Launch where you live, and tick <b>Transactions</b> only —
            it's the only Plaid product this app uses</td></tr>
        <tr><td>Use case &amp; plan</td><td>Personal finances · the free trial
            (10 banks, no credit card)</td></tr>
      </table>
      <p class="fine">Everything in the form (and any identity check) goes to Plaid only —
         this app never sees or stores it. Approval is often same-day; if Plaid takes
         longer, come back here afterwards — your progress is saved.</p>
      <button class="ghost" onclick="setStep(3)">Production access granted →</button>
    </div>
  </div>

  <div class="step" id="step3">
    <div class="step-head" onclick="setStep(3)"><div class="step-num"><span>3</span></div>
      Paste your API keys</div>
    <div class="step-body">
      <p><a class="ext" href="https://dashboard.plaid.com/developers/keys" target="_blank"
            rel="noopener">Back on the Keys page</a>, reveal the <b>Production</b> secret
         (not the Sandbox one), then select and copy the whole keys section. Paste it below —
         the keys are picked out automatically, so don't worry about copying too much.</p>
      <textarea id="rawKeys" placeholder="Paste anything from the Keys page…"
                autocomplete="off" spellcheck="false"></textarea>
      <div class="error" id="keysError"></div>
      <button class="btn" id="verifyBtn" onclick="verifyKeys()">Verify &amp; save</button>
      <p class="fine">Your secret is checked with Plaid, stored encrypted, and never shown
         again — not even to you. Pasted the Sandbox secret by mistake? We'll catch it.</p>
    </div>
  </div>

  <div class="step" id="step4">
    <div class="step-head" onclick="setStep(4)"><div class="step-num"><span>4</span></div>
      Allow the sign-in redirect</div>
    <div class="step-body">
      <p>Some banks (Chase, Bank of America, …) log you in on their own site and need to
         know where to send you back. Add this exact address:</p>
      <div class="copyrow"><code id="redirectUri"></code>
        <button class="ghost" onclick="copyText(this, REDIRECT_URI)">Copy</button></div>
      <p><a class="ext" href="https://dashboard.plaid.com/developers/api" target="_blank"
            rel="noopener">Open “Allowed redirect URIs”</a> → Add new URI → paste → save.</p>
      <button class="btn" onclick="markRedirectDone()">Done →</button>
    </div>
  </div>

  <div class="step" id="step5">
    <div class="step-head" onclick="setStep(5)"><div class="step-num"><span>5</span></div>
      Link your first bank</div>
    <div class="step-body">
      <p id="meterLine" style="display:none"><span class="meter" id="meter"></span></p>
      <p class="fine">Heads-up: the free Plaid plan allows 10 linked banks total, and
         removing one does not free the slot — link the accounts you'll keep.</p>
      <a class="btn" id="linkBtn" href="#">Add a bank</a>
    </div>
  </div>

  <footer>Doing this on your phone? It works here, but the Plaid dashboard is easier on a
    computer — sign in to the web app there and choose “Guided setup” in Settings to pick up
    where you left off. Progress is saved to your account.</footer>

<script>
let STATUS = { configured: false };
const REDIRECT_URI = __REDIRECT_URI__;
const LINK_STEP = 5;
// The Supabase JWT rides in the URL fragment — never sent to the
// server or leaked to proxy logs / Referer. Read it here for the authenticated
// /credentials + /link calls.
const ACCESS_TOKEN = new URLSearchParams(window.location.hash.slice(1)).get('access_token') || '';

const EXPIRED = "<div style='text-align:center;padding:40px'><h2>Session expired</h2>"
    + "<p>Go back to the app and open this page again "
    + "(Settings → bank connection setup).</p></div>";

if (!ACCESS_TOKEN) {
    document.body.innerHTML = EXPIRED;
} else {
    // Drop the token from the address bar / this history entry.
    history.replaceState(null, '', window.location.pathname);
    document.getElementById('linkBtn').href = '/link#access_token=' + encodeURIComponent(ACCESS_TOKEN);
    if (REDIRECT_URI) {
        document.getElementById('redirectUri').textContent = REDIRECT_URI;
    } else {
        // No redirect URI configured on this deployment — hide the step and renumber.
        document.getElementById('step4').style.display = 'none';
        document.querySelector('#step5 .step-num span').textContent = '4';
    }
    loadStatus();
}

function setStep(n) {
    for (const s of [1, 2, 3, 4, 5]) {
        document.getElementById('step' + s).classList.toggle('open', s === n);
    }
}

function markDone(n) { document.getElementById('step' + n).classList.add('done'); }

function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
        const old = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = old; }, 1500);
    });
}

function refreshFromStatus() {
    if (!STATUS.configured) return;
    markDone(1); markDone(2); markDone(3);
    document.getElementById('banner').style.display = 'block';
    document.getElementById('banner').textContent =
        'Plaid account connected (' + STATUS.client_id_masked + ') — ' +
        STATUS.items_used + ' of ' + STATUS.item_limit + ' banks linked.';
    const meter = document.getElementById('meter');
    meter.textContent = STATUS.items_used + ' of ' + STATUS.item_limit + ' bank slots used.';
    document.getElementById('meterLine').style.display = 'block';
}

function markRedirectDone() { markDone(4); setStep(LINK_STEP); }

function verifyKeys() {
    const raw = document.getElementById('rawKeys').value;
    const err = document.getElementById('keysError');
    const btn = document.getElementById('verifyBtn');
    err.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    fetch('/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   'Authorization': 'Bearer ' + ACCESS_TOKEN },
        body: JSON.stringify({ raw: raw, env: 'production' })
    }).then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || ('Something went wrong (HTTP ' + r.status + ')'));
        STATUS = body;
        document.getElementById('rawKeys').value = '';
        refreshFromStatus();
        setStep(REDIRECT_URI ? 4 : LINK_STEP);
    }).catch((e) => {
        err.textContent = e.message;
        err.style.display = 'block';
    }).finally(() => {
        btn.disabled = false;
        btn.textContent = 'Verify & save';
    });
}

// Fetch the setup status with the fragment token in the Authorization header.
// A rejected token (401) means the session is gone; a 503 is a transient
// auth-service outage — retry rather than bounce the user back to the app.
function loadStatus() {
    fetch('/credentials', { headers: { 'Authorization': 'Bearer ' + ACCESS_TOKEN } })
        .then(async (r) => {
            if (r.status === 401) { document.body.innerHTML = EXPIRED; return; }
            if (r.status === 503) { setTimeout(loadStatus, 2000); return; }
            STATUS = await r.json();
            refreshFromStatus();
            setStep(STATUS.configured ? (REDIRECT_URI ? 4 : LINK_STEP) : 1);
        })
        // Network reject (connection drop / DNS blip) is transient — retry
        // rather than fall through and mislabel a configured user as brand-new.
        .catch(() => setTimeout(loadStatus, 2000));
}
</script>
</body>
</html>"""
