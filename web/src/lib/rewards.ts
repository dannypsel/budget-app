// Rewards-page helpers — pure functions for credit display/filtering and the
// manual points-balance subtraction.

import type { ChurnCredit } from '@/types/domain'
import { creditIsUsed, creditRemaining, daysUntil } from './churning'

export type CreditListFilter = 'all' | 'needs' | 'used'

/** Short display label: program_label, else card name, else credit name. */
export function creditShortLabel(credit: ChurnCredit): string {
  return (
    credit.program_label?.trim() ||
    credit.churn_cards?.card_name?.trim() ||
    credit.credit_name
  )
}

/** Filter credits for the Rewards list. Hidden credits are always excluded. */
export function filterCredits(
  credits: ChurnCredit[],
  filter: CreditListFilter,
): ChurnCredit[] {
  const visible = credits.filter((c) => !c.is_hidden)
  if (filter === 'all') return visible
  if (filter === 'used') return visible.filter((c) => creditIsUsed(c))
  return visible.filter((c) => !creditIsUsed(c) && creditRemaining(c) > 0)
}

/** Sort nearest reset-date first; credits without a reset date sink to the end. */
export function sortCreditsByDaysRemaining(
  credits: ChurnCredit[],
  today: Date = new Date(),
): ChurnCredit[] {
  return [...credits].sort((a, b) => {
    const da = a.reset_date ? daysUntil(a.reset_date, today) : null
    const db = b.reset_date ? daysUntil(b.reset_date, today) : null
    if (da == null && db == null) return 0
    if (da == null) return 1
    if (db == null) return -1
    return da - db
  })
}

/** New points balance after logging a spend: subtract, floored at zero. */
export function newPointsBalance(balance: number, spendAmount: number): number {
  return Math.max(0, Number(balance) - Math.max(0, Number(spendAmount)))
}
