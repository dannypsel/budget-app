import { describe, expect, it } from 'vitest'
import { computeSpendingPlan, daysRemainingInMonth } from './spendingPlan'
import type { Bill, SavingsGoal } from '@/types/domain'

const bill = (amount: number, is_active = true, due_day = 1): Bill => ({
  id: `b-${amount}-${due_day}`,
  name: 'bill',
  amount,
  due_day,
  category: null,
  is_active,
})
const goal = (monthly_contribution: number): SavingsGoal => ({
  id: `g-${monthly_contribution}`,
  name: 'goal',
  target_amount: 1000,
  monthly_contribution,
})

describe('daysRemainingInMonth', () => {
  it('includes today', () => {
    // 2026-09-25: September has 30 days → 25..30 = 6 days
    expect(daysRemainingInMonth(new Date(2026, 8, 25))).toBe(6)
  })
  it('is 1 on the last day of the month', () => {
    expect(daysRemainingInMonth(new Date(2026, 8, 30))).toBe(1)
  })
  it('handles February', () => {
    // 2026 is not a leap year: 28 days
    expect(daysRemainingInMonth(new Date(2026, 1, 28))).toBe(1)
  })
})

describe('computeSpendingPlan', () => {
  const today = new Date(2026, 8, 25) // 6 days remaining

  it('computes safe-to-spend = income − active bills − goals − spending', () => {
    const r = computeSpendingPlan({
      plannedIncome: 8000,
      bills: [bill(1500), bill(200, false)],
      goals: [goal(500)],
      monthSpending: 2000,
      today,
    })
    expect(r.billsTotal).toBe(1500) // inactive bill excluded
    expect(r.goalsTotal).toBe(500)
    expect(r.planned).toBe(6000)
    expect(r.safeToSpend).toBe(4000)
    expect(r.daysRemaining).toBe(6)
    expect(r.perDay).toBeCloseTo(4000 / 6, 5)
    expect(r.spentFraction).toBeCloseTo(2000 / 6000, 5)
  })

  it('goes negative when overspent', () => {
    const r = computeSpendingPlan({
      plannedIncome: 5000,
      bills: [],
      goals: [],
      monthSpending: 6000,
      today,
    })
    expect(r.safeToSpend).toBe(-1000)
    expect(r.perDay).toBeCloseTo(-1000 / 6, 5)
    expect(r.spentFraction).toBeCloseTo(1.2, 5)
  })

  it('handles an empty plan', () => {
    const r = computeSpendingPlan({
      plannedIncome: 0,
      bills: [],
      goals: [],
      monthSpending: 0,
      today,
    })
    expect(r.safeToSpend).toBe(0)
    expect(r.spentFraction).toBe(0) // no envelope → no division by zero
  })
})
