// Spending plan storage: planned income, bills, and savings goals.
// Direct PostgREST; every query explicitly filters user_id to the caller, and
// RLS (user_id = auth.uid()) remains as defense in depth.

import { supabase } from '@/lib/supabase'
import type { Bill, BillInsert, SavingsGoal, SavingsGoalInsert, UUID } from '@/types/domain'


/** The signed-in user's id, or throw. Every new-table query scopes to this —
 *  RLS stays on as defense in depth, but the client never relies on it alone. */
async function requireUserId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  return userId
}

// ── spending_settings (one row per user) ─────────────────────────────────────

/** The caller's planned monthly income, or null when never set. */
export async function fetchPlannedIncome(): Promise<number | null> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('spending_settings')
    .select('planned_monthly_income')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  const row = data as { planned_monthly_income: string | number | null } | null
  return row?.planned_monthly_income == null ? null : Number(row.planned_monthly_income)
}

/** Create or replace the caller's planned monthly income. */
export async function savePlannedIncome(income: number): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('spending_settings')
    .upsert(
      { user_id: userId, planned_monthly_income: income, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
  if (error) throw error
}

// ── bills ───────────────────────────────────────────────────────────────────

/** All of the caller's bills, soonest due-day first. */
export async function fetchBills(): Promise<Bill[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('user_id', userId)
    .order('due_day', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as Bill[]
}

export async function createBill(bill: BillInsert): Promise<Bill> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('bills')
    .insert({ ...bill, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as Bill
}

export async function updateBill(id: UUID, patch: Partial<BillInsert>): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('bills').update(patch).eq('id', id).eq('user_id', userId)
  if (error) throw error
}

/** Flip a bill's active flag (inactive bills leave the plan math). */
export async function setBillActive(id: UUID, isActive: boolean): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('bills')
    .update({ is_active: isActive })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

export async function deleteBill(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('bills').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
}

// ── savings goals ───────────────────────────────────────────────────────────

/** All of the caller's savings goals, oldest first. */
export async function fetchSavingsGoals(): Promise<SavingsGoal[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('savings_goals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as SavingsGoal[]
}

export async function createSavingsGoal(goal: SavingsGoalInsert): Promise<SavingsGoal> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('savings_goals')
    .insert({ ...goal, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as SavingsGoal
}

export async function updateSavingsGoal(id: UUID, patch: Partial<SavingsGoalInsert>): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('savings_goals').update(patch).eq('id', id).eq('user_id', userId)
  if (error) throw error
}

export async function deleteSavingsGoal(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase.from('savings_goals').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
}
