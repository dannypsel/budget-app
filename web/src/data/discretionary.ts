// Discretionary storage: game types, ledger, challenges, check-ins, points.
// Direct PostgREST; every query explicitly filters user_id to the caller, and
// RLS (user_id = auth.uid()) remains as defense in depth.

import { supabase } from '@/lib/supabase'
import { challengePayoutInsert, challengeIsComplete } from '@/lib/discretionary'
import type {
  Challenge,
  ChallengeCheckin,
  ChallengeInsert,
  ChallengeStatus,
  DiscretionaryGameType,
  DiscretionaryLedgerEntry,
  DiscretionaryLedgerInsert,
  RewardPoints,
  RewardPointsInsert,
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

// ── game types ───────────────────────────────────────────────────────────────

/** All of the caller's game types, alphabetical. */
export async function fetchGameTypes(): Promise<DiscretionaryGameType[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('discretionary_game_types')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as DiscretionaryGameType[]
}

export async function createGameType(name: string): Promise<DiscretionaryGameType> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('discretionary_game_types')
    .insert({ name: name.trim(), user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as DiscretionaryGameType
}

/** Seed the starter game types when the user has none (idempotent: upsert on the unique name). */
export async function seedGameTypes(names: string[]): Promise<void> {
  const userId = await requireUserId()
  if (names.length === 0) return
  const { error } = await supabase
    .from('discretionary_game_types')
    .upsert(
      names.map((name) => ({ name, user_id: userId })),
      { onConflict: 'user_id,name' },
    )
  if (error) throw error
}

export async function renameGameType(id: UUID, name: string): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('discretionary_game_types')
    .update({ name: name.trim() })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

/** Delete a game type; throws when ledger rows still reference it so the
 *  caller can block the delete with a message. */
export async function deleteGameType(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { count, error: countError } = await supabase
    .from('discretionary_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('game_type_id', id)
  if (countError) throw countError
  if ((count ?? 0) > 0) {
    throw new Error(`This game type is used in ${count} ledger ${count === 1 ? 'entry' : 'entries'} and cannot be removed.`)
  }
  const { error } = await supabase
    .from('discretionary_game_types')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

// ── ledger ───────────────────────────────────────────────────────────────────

/** The caller's full discretionary ledger, newest date first. */
export async function fetchDiscretionaryLedger(): Promise<DiscretionaryLedgerEntry[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('discretionary_ledger')
    .select('*')
    .eq('user_id', userId)
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as DiscretionaryLedgerEntry[]
}

export async function createLedgerEntry(
  insert: DiscretionaryLedgerInsert,
): Promise<DiscretionaryLedgerEntry> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('discretionary_ledger')
    .insert({ ...insert, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as DiscretionaryLedgerEntry
}

/** True when a ledger row already exists for this challenge (payout idempotency). */
export async function challengeHasPayout(challengeId: UUID): Promise<boolean> {
  const userId = await requireUserId()
  const { count, error } = await supabase
    .from('discretionary_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('challenge_id', challengeId)
  if (error) throw error
  return (count ?? 0) > 0
}

// ── challenges ───────────────────────────────────────────────────────────────

export async function fetchChallenges(): Promise<Challenge[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('challenges')
    .select('*')
    .eq('user_id', userId)
    .order('start_date', { ascending: false })
  if (error) throw error
  return (data ?? []) as Challenge[]
}

export async function createChallenge(insert: ChallengeInsert): Promise<Challenge> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('challenges')
    .insert({ ...insert, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as Challenge
}

export async function updateChallengeStatus(id: UUID, status: ChallengeStatus): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('challenges')
    .update({ status })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

/** Mark a challenge completed: set status AND insert the reward ledger row.
 *  Idempotent — if a payout row already exists for the challenge, only the
 *  status is updated and no second payout is inserted. */
export async function completeChallenge(challenge: Challenge): Promise<void> {
  const alreadyPaid = await challengeHasPayout(challenge.id)
  if (!alreadyPaid) {
    await createLedgerEntry(challengePayoutInsert(challenge))
  }
  await updateChallengeStatus(challenge.id, 'completed')
}

/** Evaluate the completion rule and pay out when reached. Returns true when the
 *  challenge was marked complete by this call. Safe to call repeatedly. */
export async function evaluateChallengeCompletion(
  challenge: Challenge,
  checkinCount: number,
): Promise<boolean> {
  if (challenge.status !== 'active') return false
  if (!challengeIsComplete(challenge, checkinCount)) return false
  await completeChallenge(challenge)
  return true
}

// ── check-ins ────────────────────────────────────────────────────────────────

export async function fetchCheckins(challengeId: UUID): Promise<ChallengeCheckin[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('challenge_checkins')
    .select('*')
    .eq('user_id', userId)
    .eq('challenge_id', challengeId)
  if (error) throw error
  return (data ?? []) as ChallengeCheckin[]
}

/** Toggle a check-in for a challenge day: delete when present, insert when absent. */
export async function toggleCheckin(challengeId: UUID, date: string): Promise<boolean> {
  const userId = await requireUserId()
  const { data: existing, error: findError } = await supabase
    .from('challenge_checkins')
    .select('id')
    .eq('user_id', userId)
    .eq('challenge_id', challengeId)
    .eq('checkin_date', date)
    .maybeSingle()
  if (findError) throw findError
  if (existing) {
    const { error } = await supabase
      .from('challenge_checkins')
      .delete()
      .eq('id', (existing as { id: UUID }).id)
      .eq('user_id', userId)
    if (error) throw error
    return false
  }
  const { error } = await supabase
    .from('challenge_checkins')
    .insert({ challenge_id: challengeId, checkin_date: date, user_id: userId })
  if (error) throw error
  return true
}

// ── reward points ────────────────────────────────────────────────────────────

export async function fetchRewardPoints(): Promise<RewardPoints[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('reward_points')
    .select('*')
    .eq('user_id', userId)
    .order('program', { ascending: true })
  if (error) throw error
  return (data ?? []) as RewardPoints[]
}

export async function createRewardPoint(insert: RewardPointsInsert): Promise<RewardPoints> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('reward_points')
    .insert({
      ...insert,
      user_id: userId,
      last_updated: insert.last_updated ?? new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  return data as RewardPoints
}

export async function updateRewardPoint(
  id: UUID,
  patch: Partial<RewardPointsInsert>,
): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('reward_points')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

/** "Log spend": subtract an amount from the balance and stamp last_updated. */
export async function logRewardPointsSpend(id: UUID, balance: number, spendAmount: number): Promise<void> {
  const userId = await requireUserId()
  const next = Math.max(0, Number(balance) - Math.max(0, Number(spendAmount)))
  const { error } = await supabase
    .from('reward_points')
    .update({ balance: next, last_updated: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}
