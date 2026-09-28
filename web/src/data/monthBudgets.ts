// Monthly per-category budgets — direct PostgREST. Every query explicitly
// filters user_id to the caller; RLS (user_id = auth.uid()) stays on as
// defense in depth. `month` is always a first-of-month yyyy-MM-dd string.

import { supabase } from '@/lib/supabase'
import type { Budget } from '@/types/domain'

async function requireUserId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  return userId
}

/** All budget targets for one month (first-of-month yyyy-MM-dd). */
export async function fetchBudgets(monthFirstISO: string): Promise<Budget[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('budgets')
    .select('*')
    .eq('user_id', userId)
    .eq('month', monthFirstISO)
    .order('category', { ascending: true })
  if (error) throw error
  return (data ?? []) as Budget[]
}

/** Upsert one category's target for a month. A null target deletes the row. */
export async function saveBudgetTarget(
  monthFirstISO: string,
  category: string,
  target: number | null,
): Promise<void> {
  const userId = await requireUserId()
  if (target == null) {
    const { error } = await supabase
      .from('budgets')
      .delete()
      .eq('user_id', userId)
      .eq('month', monthFirstISO)
      .eq('category', category)
    if (error) throw error
    return
  }
  const { error } = await supabase.from('budgets').upsert(
    { user_id: userId, month: monthFirstISO, category, target },
    { onConflict: 'user_id,month,category' },
  )
  if (error) throw error
}

/** Sum of budget targets for a month — feeds the forecast baseline. */
export async function fetchBudgetTargetsTotal(monthFirstISO: string): Promise<number> {
  const budgets = await fetchBudgets(monthFirstISO)
  return budgets.reduce((s, b) => s + Number(b.target), 0)
}
