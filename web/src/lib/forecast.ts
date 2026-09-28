// Forecast math — pure functions over already-fetched rows, so they're
// unit-testable without Supabase. The baseline is always computed live from
// the spending plan; nothing here is hardcoded.

import type { Bill, ForecastAdjustment, SavingsGoal } from '@/types/domain'

export interface ForecastBaselineTerms {
  plannedIncome: number
  billsTotal: number
  goalsTotal: number
  budgetsTotal: number
  /** plannedIncome − bills − goals − budgets: the live monthly surplus. */
  baseline: number
}

/** Live spending-plan surplus for one month: planned income minus active bills,
 *  savings-goal contributions, and this month's budget targets. */
export function computeForecastBaseline(
  plannedIncome: number | null,
  bills: Bill[],
  goals: SavingsGoal[],
  budgetTargets: number[],
): ForecastBaselineTerms {
  const billsTotal = bills
    .filter((b) => b.is_active)
    .reduce((s, b) => s + Number(b.amount), 0)
  const goalsTotal = goals.reduce((s, g) => s + Number(g.monthly_contribution), 0)
  const budgetsTotal = budgetTargets.reduce((s, t) => s + Number(t), 0)
  const income = plannedIncome ?? 0
  return {
    plannedIncome: income,
    billsTotal,
    goalsTotal,
    budgetsTotal,
    baseline: income - billsTotal - goalsTotal - budgetsTotal,
  }
}

/** "yyyy-MM" key of a first-of-month "yyyy-MM-dd" string. */
function monthKey(firstISO: string): string {
  return firstISO.slice(0, 7)
}

/** True when the adjustment changes net worth in the given projection month
 *  (first-of-month "yyyy-MM-dd"). Recurring adjustments apply to every month in
 *  [start_month, end_month]; open ends are unbounded. */
export function adjustmentAppliesInMonth(
  adj: Pick<ForecastAdjustment, 'kind' | 'start_month' | 'end_month' | 'month'>,
  monthFirstISO: string,
): boolean {
  const key = monthKey(monthFirstISO)
  if (adj.kind === 'one_time') {
    return adj.month != null && monthKey(adj.month) === key
  }
  if (adj.start_month != null && monthKey(adj.start_month) > key) return false
  if (adj.end_month != null && monthKey(adj.end_month) < key) return false
  return true
}

/** Signed monthly impact of an adjustment: income +, spending −. */
export function adjustmentSignedAmount(
  adj: Pick<ForecastAdjustment, 'direction' | 'amount'>,
): number {
  const amt = Number(adj.amount)
  return adj.direction === 'income' ? amt : -amt
}

export interface ForecastAppliedAdjustment {
  name: string
  signedAmount: number
}

export interface ForecastMonth {
  /** First-of-month "yyyy-MM-dd". */
  month: string
  /** "Oct 2026". */
  label: string
  baseline: number
  adjustments: ForecastAppliedAdjustment[]
  /** Σ signed adjustment amounts. */
  adjustmentsTotal: number
  netChange: number
  startBalance: number
  endBalance: number
}

export interface ForecastProjection {
  months: ForecastMonth[]
  totalChange: number
  endBalance: number
}

/** Add `n` months to a first-of-month date, returning the new first-of-month. */
export function addMonths(firstISO: string, n: number): string {
  const [y, m] = firstISO.split('-').map(Number)
  const d = new Date(y, (m - 1) + n, 1)
  const yy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${yy}-${mm}-01`
}

function monthLabel(firstISO: string): string {
  const [y, m] = firstISO.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  })
}

export interface ProjectForecastInput {
  startingNetWorth: number
  baselineMonthly: number
  adjustments: ForecastAdjustment[]
  /** Positive integer months. */
  horizonMonths: number
  /** First-of-month "yyyy-MM-dd" the projection starts on. */
  startMonthFirstISO: string
}

/** Month-by-month net-worth projection: each month's change is the baseline
 *  plus that month's signed adjustments, compounded onto the running balance. */
export function projectForecast(input: ProjectForecastInput): ForecastProjection {
  const horizon = Math.max(1, Math.floor(input.horizonMonths))
  const months: ForecastMonth[] = []
  let balance = input.startingNetWorth
  for (let i = 0; i < horizon; i++) {
    const month = addMonths(input.startMonthFirstISO, i)
    const applied = input.adjustments
      .filter((a) => adjustmentAppliesInMonth(a, month))
      .map((a) => ({ name: a.name, signedAmount: adjustmentSignedAmount(a) }))
    const adjustmentsTotal = applied.reduce((s, a) => s + a.signedAmount, 0)
    const netChange = input.baselineMonthly + adjustmentsTotal
    const startBalance = balance
    balance += netChange
    months.push({
      month,
      label: monthLabel(month),
      baseline: input.baselineMonthly,
      adjustments: applied,
      adjustmentsTotal,
      netChange,
      startBalance,
      endBalance: balance,
    })
  }
  return {
    months,
    totalChange: balance - input.startingNetWorth,
    endBalance: balance,
  }
}
