import { describe, expect, it } from 'vitest'
import { buildBudgetRows, budgetTotals } from './budgetTotals'
import type { Budget, Category } from '@/types/domain'

const cat = (id: string, name: string): Category => ({
  id,
  name,
  icon: 'cart.fill',
  color: '#34C759',
  parent_id: null,
  group_id: null,
  sort_order: 0,
  kind: 'spend',
  is_active: true,
})
const budget = (category: string, target: number): Budget => ({
  id: `b-${category}`,
  month: '2026-10-01',
  category,
  target,
})

describe('buildBudgetRows', () => {
  it('joins targets by name and spend by category id', () => {
    const rows = buildBudgetRows(
      [cat('1', 'Groceries'), cat('2', 'Dining')],
      [budget('Groceries', 800), budget('Dining', 300)],
      [{ categoryId: '1', total: 500 }, { categoryId: '2', total: 350 }],
    )
    expect(rows).toHaveLength(2)
    const g = rows.find((r) => r.category === 'Groceries')!
    expect(g.target).toBe(800)
    expect(g.actual).toBe(500)
    expect(g.remaining).toBe(300)
    expect(g.fraction).toBeCloseTo(500 / 800, 6)
    expect(g.overBudget).toBe(false)
    const d = rows.find((r) => r.category === 'Dining')!
    expect(d.overBudget).toBe(true)
    expect(d.remaining).toBe(-50)
  })

  it('leaves target-less categories unflagged', () => {
    const rows = buildBudgetRows([cat('1', 'Groceries')], [], [{ categoryId: '1', total: 500 }])
    expect(rows[0].target).toBe(0)
    expect(rows[0].fraction).toBe(0)
    expect(rows[0].overBudget).toBe(false)
  })

  it('keeps budget-only names for renamed/archived categories', () => {
    const rows = buildBudgetRows([cat('1', 'Groceries')], [budget('Old name', 100)], [])
    expect(rows).toHaveLength(2)
    const orphan = rows.find((r) => r.category === 'Old name')!
    expect(orphan.categoryId).toBeNull()
    expect(orphan.target).toBe(100)
    expect(orphan.actual).toBe(0)
  })

  it('sorts by category name', () => {
    const rows = buildBudgetRows([cat('2', 'Zebra'), cat('1', 'Apple')], [], [])
    expect(rows.map((r) => r.category)).toEqual(['Apple', 'Zebra'])
  })
})

describe('budgetTotals', () => {
  it('sums targets and actuals', () => {
    const rows = buildBudgetRows(
      [cat('1', 'A'), cat('2', 'B')],
      [budget('A', 800), budget('B', 200)],
      [{ categoryId: '1', total: 500 }, { categoryId: '2', total: 250 }],
    )
    const t = budgetTotals(rows)
    expect(t.target).toBe(1000)
    expect(t.actual).toBe(750)
    expect(t.remaining).toBe(250)
    expect(t.fraction).toBeCloseTo(0.75, 6)
    expect(t.overBudget).toBe(false)
  })

  it('handles no targets without flagging', () => {
    const t = budgetTotals(buildBudgetRows([cat('1', 'A')], [], []))
    expect(t.fraction).toBe(0)
    expect(t.overBudget).toBe(false)
  })
})
