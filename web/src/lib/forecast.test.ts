import { describe, expect, it } from 'vitest'
import {
  addMonths,
  adjustmentAppliesInMonth,
  adjustmentSignedAmount,
  computeForecastBaseline,
  projectForecast,
} from './forecast'
import type { Bill, ForecastAdjustment, SavingsGoal } from '@/types/domain'

const bill = (amount: number, is_active = true): Bill => ({
  id: 'b',
  name: 'b',
  amount,
  due_day: 1,
  category: null,
  is_active,
})
const goal = (monthly_contribution: number): SavingsGoal => ({
  id: 'g',
  name: 'g',
  target_amount: 1000,
  monthly_contribution,
})
const adj = (
  partial: Partial<ForecastAdjustment>,
): ForecastAdjustment => ({
  id: 'a',
  kind: 'one_time',
  direction: 'spending',
  name: 'adj',
  amount: 100,
  start_month: null,
  end_month: null,
  month: null,
  ...partial,
})

describe('computeForecastBaseline', () => {
  it('subtracts active bills, goals, and budget targets from planned income', () => {
    const t = computeForecastBaseline(8000, [bill(1500), bill(200, false)], [goal(500)], [1200, 300])
    expect(t.billsTotal).toBe(1500)
    expect(t.goalsTotal).toBe(500)
    expect(t.budgetsTotal).toBe(1500)
    expect(t.baseline).toBe(8000 - 1500 - 500 - 1500)
  })

  it('treats null planned income as zero', () => {
    const t = computeForecastBaseline(null, [], [], [])
    expect(t.plannedIncome).toBe(0)
    expect(t.baseline).toBe(0)
  })
})

describe('adjustmentAppliesInMonth', () => {
  it('one-time applies only in its month', () => {
    const a = adj({ kind: 'one_time', month: '2026-11-01' })
    expect(adjustmentAppliesInMonth(a, '2026-11-01')).toBe(true)
    expect(adjustmentAppliesInMonth(a, '2026-12-01')).toBe(false)
    expect(adjustmentAppliesInMonth(a, '2026-10-01')).toBe(false)
  })

  it('recurring applies inside an inclusive window', () => {
    const a = adj({
      kind: 'recurring',
      start_month: '2026-10-01',
      end_month: '2026-12-01',
    })
    expect(adjustmentAppliesInMonth(a, '2026-09-01')).toBe(false)
    expect(adjustmentAppliesInMonth(a, '2026-10-01')).toBe(true)
    expect(adjustmentAppliesInMonth(a, '2026-11-01')).toBe(true)
    expect(adjustmentAppliesInMonth(a, '2026-12-01')).toBe(true)
    expect(adjustmentAppliesInMonth(a, '2027-01-01')).toBe(false)
  })

  it('recurring with open ends is unbounded', () => {
    const a = adj({ kind: 'recurring', start_month: null, end_month: null })
    expect(adjustmentAppliesInMonth(a, '2030-01-01')).toBe(true)
    const b = adj({ kind: 'recurring', start_month: '2026-10-01', end_month: null })
    expect(adjustmentAppliesInMonth(b, '2026-09-01')).toBe(false)
    expect(adjustmentAppliesInMonth(b, '2029-06-01')).toBe(true)
  })
})

describe('adjustmentSignedAmount', () => {
  it('income is positive, spending is negative', () => {
    expect(adjustmentSignedAmount(adj({ direction: 'income', amount: 200 }))).toBe(200)
    expect(adjustmentSignedAmount(adj({ direction: 'spending', amount: 200 }))).toBe(-200)
  })
})

describe('addMonths', () => {
  it('rolls over year boundaries', () => {
    expect(addMonths('2026-11-01', 2)).toBe('2027-01-01')
    expect(addMonths('2026-01-01', 0)).toBe('2026-01-01')
  })
})

describe('projectForecast', () => {
  it('compounds the baseline month over month', () => {
    const p = projectForecast({
      startingNetWorth: 10000,
      baselineMonthly: 1000,
      adjustments: [],
      horizonMonths: 3,
      startMonthFirstISO: '2026-10-01',
    })
    expect(p.months).toHaveLength(3)
    expect(p.months[0].startBalance).toBe(10000)
    expect(p.months[0].endBalance).toBe(11000)
    expect(p.months[2].endBalance).toBe(13000)
    expect(p.totalChange).toBe(3000)
    expect(p.endBalance).toBe(13000)
  })

  it('layers one-time and recurring adjustments into the right months', () => {
    const p = projectForecast({
      startingNetWorth: 0,
      baselineMonthly: 1000,
      adjustments: [
        adj({ kind: 'one_time', direction: 'spending', name: 'trip', amount: 500, month: '2026-11-01' }),
        adj({ kind: 'recurring', direction: 'income', name: 'raise', amount: 200, start_month: '2026-10-01', end_month: null }),
      ],
      horizonMonths: 2,
      startMonthFirstISO: '2026-10-01',
    })
    // Oct: 1000 + 200 = 1200; Nov: 1000 + 200 − 500 = 700
    expect(p.months[0].netChange).toBe(1200)
    expect(p.months[1].netChange).toBe(700)
    expect(p.months[1].adjustments.map((a) => a.name).sort()).toEqual(['raise', 'trip'])
    expect(p.endBalance).toBe(1900)
  })

  it('clamps the horizon to at least one month', () => {
    const p = projectForecast({
      startingNetWorth: 0,
      baselineMonthly: 100,
      adjustments: [],
      horizonMonths: 0,
      startMonthFirstISO: '2026-10-01',
    })
    expect(p.months).toHaveLength(1)
  })
})
