// account_balance_history reads for the Net Worth and Savings reports. The sync
// writes one row per account per sync day (unique (account_id, date)).

import { supabase } from '@/lib/supabase'
import { fetchAllPages } from './transactions'
import type { UUID } from '@/types/domain'

export interface BalancePoint {
  account_id: UUID
  date: string // yyyy-MM-dd
  current_balance: number | null
}

/** Balance rows dated in [startISO, endISO], oldest first. Callers pass a start a
 *  little before the report range so month-end values can carry forward. */
export async function fetchBalanceHistory(startISO: string, endISO: string): Promise<BalancePoint[]> {
  const rows = await fetchAllPages((from, to) =>
    supabase
      .from('account_balance_history')
      .select('account_id, date, current_balance')
      .gte('date', startISO)
      .lte('date', endISO)
      .order('date', { ascending: true })
      .order('account_id')
      .range(from, to),
  )
  return (rows as BalancePoint[]).map((r) => ({
    ...r,
    current_balance: r.current_balance == null ? null : Number(r.current_balance),
  }))
}
