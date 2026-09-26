// Churning tracker storage: cards, signup bonuses, and card credits.
// Direct PostgREST; every query explicitly filters user_id to the caller, and
// RLS (user_id = auth.uid()) remains as defense in depth.
//
// Money convention (see lib/money.ts): Transaction.amount > 0 = spend/outflow,
// amount < 0 = income/inflow.

import { supabase } from '@/lib/supabase'
import type {
  ChurnBonus,
  ChurnBonusInsert,
  ChurnCard,
  ChurnCardInsert,
  ChurnCredit,
  ChurnCreditInsert,
  UUID,
} from '@/types/domain'


/** The signed-in user's id, or throw. Every new-table query scopes to this —
 *  RLS stays on as defense in depth, but the client never relies on it alone. */
async function requireUserId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  return userId
}

// ── cards ───────────────────────────────────────────────────────────────────

/** All of the caller's tracked cards, newest first. */
export async function fetchChurnCards(): Promise<ChurnCard[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_cards')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as ChurnCard[]
}

export async function fetchChurnCard(id: UUID): Promise<ChurnCard | null> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_cards')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return (data as ChurnCard | null) ?? null
}

export async function createChurnCard(card: ChurnCardInsert): Promise<ChurnCard> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_cards')
    .insert({ ...card, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as ChurnCard
}

export async function updateChurnCard(id: UUID, patch: Partial<ChurnCardInsert>): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('churn_cards').update(patch).eq('id', id).eq('user_id', userId)
  if (error) throw error
}

export async function deleteChurnCard(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('churn_cards').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
}

// ── bonuses ─────────────────────────────────────────────────────────────────

/** A card's bonuses, nearest spend-by date first. */
export async function fetchChurnBonuses(cardId: UUID): Promise<ChurnBonus[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_bonuses')
    .select('*')
    .eq('card_id', cardId)
    .eq('user_id', userId)
    .order('spend_by_date', { ascending: true })
  if (error) throw error
  return (data ?? []) as ChurnBonus[]
}

/** All of the caller's bonuses (deadlines widget), joined to their card names. */
export async function fetchAllChurnBonuses(): Promise<ChurnBonus[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_bonuses')
    .select('*, churn_cards(card_name)')
    .eq('user_id', userId)
    .order('spend_by_date', { ascending: true })
  if (error) throw error
  return (data ?? []) as ChurnBonus[]
}

export async function createChurnBonus(bonus: ChurnBonusInsert): Promise<ChurnBonus> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_bonuses')
    .insert({ ...bonus, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as ChurnBonus
}

export async function updateChurnBonus(id: UUID, patch: Partial<ChurnBonusInsert>): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('churn_bonuses').update(patch).eq('id', id).eq('user_id', userId)
  if (error) throw error
}

export async function deleteChurnBonus(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('churn_bonuses').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
}

// ── credits ─────────────────────────────────────────────────────────────────

/** A card's credits, soonest reset first. */
export async function fetchChurnCredits(cardId: UUID): Promise<ChurnCredit[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_credits')
    .select('*')
    .eq('card_id', cardId)
    .eq('user_id', userId)
    .order('reset_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as ChurnCredit[]
}

export async function createChurnCredit(credit: ChurnCreditInsert): Promise<ChurnCredit> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_credits')
    .insert({ ...credit, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as ChurnCredit
}

/** Every credit across the caller's cards (deadlines widget, attention section),
 *  joined to their card names. */
export async function fetchAllChurnCredits(): Promise<ChurnCredit[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('churn_credits')
    .select('*, churn_cards(card_name)')
    .eq('user_id', userId)
    .order('reset_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as ChurnCredit[]
}

export async function updateChurnCredit(id: UUID, patch: Partial<ChurnCreditInsert>): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('churn_credits').update(patch).eq('id', id).eq('user_id', userId)
  if (error) throw error
}

export async function deleteChurnCredit(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('churn_credits').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
}

// ── auto-detection ──────────────────────────────────────────────────────────

const BACKEND = import.meta.env.VITE_BACKEND_URL as string

/** Ask the backend to scan recent transactions for matches against the caller's
 *  auto-detect-enabled credits (POST /credits/detect). Returns how many credits
 *  were newly marked used. Best-effort: callers wrap in try/catch so a backend
 *  hiccup (or a not-yet-deployed endpoint) never breaks the surrounding flow. */
export async function detectCreditsAfterImport(): Promise<number> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return 0
  const res = await fetch(`${BACKEND}/credits/detect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return 0
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const n =
    body == null
      ? 0
      : Array.isArray(body)
        ? body.length
        : Number(body.detected ?? body.count ?? body.matched ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// ── qualifying spend ────────────────────────────────────────────────────────

/** Outflow transactions on the card's linked account inside the bonus window, with
 *  the same exclusions as every spend total: rows with exclude_from_totals=true
 *  (which is how linked transfer legs are excluded) are dropped, and transfer
 *  legs are dropped explicitly too. Credits (amount < 0) never count. */
export async function fetchQualifyingSpend(opts: {
  accountId: UUID
  startDate: string // yyyy-MM-dd, inclusive
  endDate: string // yyyy-MM-dd, inclusive
}): Promise<number> {
  const { data, error } = await supabase
    .from('transactions')
    .select('amount')
    .eq('account_id', opts.accountId)
    .gte('effective_date', opts.startDate)
    .lte('effective_date', opts.endDate)
    .eq('exclude_from_totals', false)
    .is('transfer_group_id', null)
    .gt('amount', 0)
  if (error) throw error
  return ((data ?? []) as { amount: number | string }[]).reduce(
    (s, r) => s + Number(r.amount),
    0,
  )
}
