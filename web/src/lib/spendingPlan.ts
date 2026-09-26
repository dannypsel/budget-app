// Spending-plan math — pure functions over already-fetched rows, so they're
// unit-testable without Supabase.
//
// Sign convention (see lib/money.ts): Transaction.amount > 0 = spend/outflow,
// amount < 0 = income/inflow. `monthSpending` MUST use the same spend definition
// as the transactions views: outflows only (Σ positive spend − Σ reimbursement
// credit magnitudes), excluding exclude_from_totals=true rows (transfer legs are
// excluded from totals exactly this way when linked).

import type { Bill, SavingsGoal } from '@/types/domain'

export interface SpendingPlanInput {
  /** Planned monthly take-home income (user-entered). */
  plannedIncome: number
  bills: Bill[]
  goals: SavingsGoal[]
  /** Month-to-date spend, same definition as the transactions views. */
  monthSpending: number
  /** "Today" — injectable for tests. */
  today?: Date
}

export interface SpendingPlanResult {
  billsTotal: number
  goalsTotal: number
  /** plannedIncome − bills − goals: the month's discretionary envelope. */
  planned: number
  spent: number
  /** plannedIncome − bills − goals − spent: Simplifi's "safe to spend". */
  safeToSpend: number
  /** Calendar days left in the month, including today. */
  daysRemaining: number
  /** safeToSpend ÷ daysRemaining. */
  perDay: number
  /** Fraction of the envelope spent, 0–1+ (for progress bars). */
  spentFraction: number
}

/** Days left in `today`'s month, including today (e.g. the 25th of a 30-day
 *  month → 6). Exported for testing. */
export function daysRemainingInMonth(today: Date): number {
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  return Math.max(1, daysInMonth - today.getDate() + 1)
}

export function computeSpendingPlan(input: SpendingPlanInput): SpendingPlanResult {
  const today = input.today ?? new Date()
  const billsTotal = input.bills
    .filter((b) => b.is_active)
    .reduce((s, b) => s + Number(b.amount), 0)
  const goalsTotal = input.goals.reduce((s, g) => s + Number(g.monthly_contribution), 0)
  const planned = input.plannedIncome - billsTotal - goalsTotal
  const safeToSpend = planned - input.monthSpending
  const daysRemaining = daysRemainingInMonth(today)
  return {
    billsTotal,
    goalsTotal,
    planned,
    spent: input.monthSpending,
    safeToSpend,
    daysRemaining,
    perDay: safeToSpend / daysRemaining,
    spentFraction: planned > 0 ? input.monthSpending / planned : 0,
  }
}
