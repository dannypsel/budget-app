// Mirrors PocketLens/Services/SyncService.swift + AccountLinking.swift (Plaid).
// The only two calls that go to the Render backend instead of Supabase.

import { supabase } from '@/lib/supabase'
import { warm } from '@/data/backend'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not signed in')
  return token
}

/** Summary returned by POST /sync/trigger once the sync has run inline.
 *  All numeric fields are optional: the backend shape may grow, and an older
 *  backend only returns {status:'ok'}. Callers must not assume any field. */
export interface SyncSummary {
  status?: string
  items_synced?: number
  transactions_added?: number
  transactions_modified?: number
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

const POLL_MS = 3000
const START_GRACE_MS = 45_000
const MAX_WAIT_MS = 10 * 60_000

interface SyncLogRow {
  status: string
  started_at: string
  finished_at: string | null
  error_message: string | null
  transactions_added: number | null
  transactions_modified: number | null
}

/** The newest sync_log row started at/after `sinceISO`, or null. */
async function latestSyncLog(sinceISO: string): Promise<SyncLogRow | null> {
  const { data, error } = await supabase
    .from('sync_log')
    .select('status, started_at, finished_at, error_message, transactions_added, transactions_modified')
    .gte('started_at', sinceISO)
    .order('started_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data ?? [])[0] as SyncLogRow | undefined) ?? null
}

/** The request outlived API Gateway's 30 s integration cap (its timeout reply
 *  has no CORS headers, so the browser only sees a failed fetch), but Lambda
 *  keeps running. Follow the run through sync_log until it finishes. */
async function waitForSyncLog(sinceISO: string, sleep: (ms: number) => Promise<void>): Promise<SyncSummary> {
  const t0 = Date.now()
  for (;;) {
    const row = await latestSyncLog(sinceISO)
    if (row && row.status !== 'running') {
      if (row.status === 'error') throw new Error('Sync failed on the server — check the sync log')
      return {
        status: row.status,
        transactions_added: asNumber(row.transactions_added),
        transactions_modified: asNumber(row.transactions_modified),
      }
    }
    const waited = Date.now() - t0
    if (!row && waited > START_GRACE_MS) throw new Error('Sync did not start — try again')
    if (waited > MAX_WAIT_MS) throw new Error('Sync is taking unusually long — check back shortly')
    await sleep(POLL_MS)
  }
}

/** POST once after warming the function. 'timeout' = API Gateway gave up (or the
 *  network dropped) while Lambda may still be running the long request. */
async function postOnce(path: string): Promise<Response | 'timeout'> {
  const token = await accessToken()
  await warm().catch(() => {})
  try {
    const res = await fetch(`${BACKEND}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    return res.status === 502 || res.status === 503 || res.status === 504 ? 'timeout' : res
  } catch {
    return 'timeout'
  }
}

let inFlight: Promise<SyncSummary> | null = null

/** Run a Plaid sync for the signed-in user. POSTs /sync/trigger exactly once —
 *  never retried, because a retry starts a second full sync on top of the one
 *  still running. A refresh that outlasts the API Gateway timeout is followed
 *  to completion via sync_log. Concurrent callers (sign-in auto-sync + a tap)
 *  share one run. */
export function triggerSync(): Promise<SyncSummary> {
  inFlight ??= runSync().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runSync(sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<SyncSummary> {
  const sinceISO = new Date(Date.now() - 5000).toISOString()
  const res = await postOnce('/sync/trigger')
  if (res === 'timeout') return waitForSyncLog(sinceISO, sleep)
  if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`)
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return {
    status: typeof body.status === 'string' ? body.status : 'ok',
    items_synced: asNumber(body.items_synced),
    transactions_added: asNumber(body.transactions_added),
    transactions_modified: asNumber(body.transactions_modified),
  }
}

/** Test hook: run one sync with an injected sleep, bypassing the shared in-flight run. */
export const __runSyncForTest = runSync

/** Human-readable one-liner for a sync summary. Tolerates a summary with no
 *  numbers (e.g. from an older fire-and-forget backend) — always returns a
 *  complete sentence. */
export function describeSyncSummary(summary: SyncSummary): string {
  const added = summary.transactions_added ?? 0
  const items = summary.items_synced ?? 0
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (added > 0 && items > 0)
    return `Sync complete — ${plural(added, 'new transaction')} across ${plural(items, 'account')}.`
  if (added > 0) return `Sync complete — ${plural(added, 'new transaction')}.`
  if (items > 0) return `Sync complete — ${plural(items, 'account')} synced.`
  return 'Sync complete.'
}

/** Reset the cursor for a newly-linked item and kick off a full historical sync. */
export async function requestBackfill(itemId: string): Promise<void> {
  const res = await postOnce(`/backfill/${encodeURIComponent(itemId)}`)
  // A history pull outlasting the gateway timeout keeps running in Lambda.
  if (res !== 'timeout' && !res.ok) throw new Error(`Backfill failed: HTTP ${res.status}`)
}

/** Result of a full sync request. `cooldown` means the user full-synced too
 *  recently; `next_at` is when the next one is allowed (ISO-8601). */
export type BackfillAllResult =
  | { status: 'ok'; items: number }
  | { status: 'cooldown'; next_at: string }

/** Full sync: reset every linked bank's cursor and re-pull the full 730-day
 *  window. Rate-limited server-side — a 429 resolves to a `cooldown` result
 *  (not thrown) so the caller can surface when the next full sync is available. */
export async function backfillAll(): Promise<BackfillAllResult> {
  const res = await postOnce('/backfill-all')
  // Outlasted the gateway timeout: the full re-pull is running server-side.
  if (res === 'timeout') return { status: 'ok', items: 0 }
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { next_at?: string }
    return { status: 'cooldown', next_at: body.next_at ?? '' }
  }
  if (!res.ok) throw new Error(`Full sync failed: HTTP ${res.status}`)
  const body = (await res.json()) as { items?: number }
  return { status: 'ok', items: body.items ?? 0 }
}

/** URL of the backend-hosted Plaid Link page, tied to this user via their access token.
 *  Open in a new tab/popup (iOS opens it in a Safari sheet). */
export async function plaidLinkUrl(): Promise<string> {
  return backendPageUrl('link')
}

/** URL of the backend-hosted guided Plaid onboarding wizard (BYO developer account). */
export async function plaidOnboardUrl(): Promise<string> {
  return backendPageUrl('onboard')
}

/** URL of the hosted Plaid Link page in *update mode* for an existing item, to
 *  repair a broken connection (re-auth / new MFA). The hosted shell parses
 *  `item_id` from the fragment, and on success postMessages a PLAID_LINK_SUCCESS
 *  with no `new_account` field. Open via openWarmTab like plaidLinkUrl. */
export async function plaidReconnectUrl(itemId: string): Promise<string> {
  return backendPageUrl('link', `&item_id=${encodeURIComponent(itemId)}`)
}

async function backendPageUrl(path: string, extraHash = ''): Promise<string> {
  const token = await accessToken()
  const u = new URL(`${BACKEND}/${path}`)
  // Token goes in the URL fragment, not a query param: the browser never sends
  // the fragment to the server or leaks it via proxy logs / Referer.
  // The hosted page's JS reads it from location.hash.
  u.hash = `access_token=${encodeURIComponent(token)}${extraHash}`
  return u.toString()
}
