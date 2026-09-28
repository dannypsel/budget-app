// Budget page math — pure functions over already-fetched rows. A budget row
// joins a category (from the categories table), its target for the month (from
// the budgets table, keyed by category NAME), and its actual spend (from the
// category_spend view, keyed by category id).

import type { Budget, Category } from '@/types/domain'

export interface BudgetRow {
  /** Category name — the budgets table keys targets by name. */
  category: string
  /** Null when the category is archived/missing but still has a target. */
  categoryId: string | null
  target: number
  actual: number
  remaining: number
  /** actual ÷ target, 0–1+ (for progress bars); 0 when no target is set. */
  fraction: number
  /** True only when a target exists and actuals exceed it. */
  overBudget: boolean
}

export interface BudgetSpend {
  categoryId: string
  total: number
}

/** One row per category (active categories first, then any budget-only names),
 *  sorted by category name. */
export function buildBudgetRows(
  categories: Category[],
  budgets: Budget[],
  spend: BudgetSpend[],
): BudgetRow[] {
  const targetByName = new Map<string, number>()
  for (const b of budgets) targetByName.set(b.category, Number(b.target))
  const spendById = new Map<string, number>()
  for (const s of spend) spendById.set(s.categoryId, s.total)

  const rows: BudgetRow[] = categories.map((c) => {
    const target = targetByName.get(c.name) ?? 0
    const actual = spendById.get(c.id) ?? 0
    return toRow(c.name, c.id, target, actual)
  })
  // Budget targets for categories that no longer exist (renamed/archived) —
  // keep them visible so the money isn't silently dropped.
  const known = new Set(categories.map((c) => c.name))
  for (const [name, target] of targetByName) {
    if (!known.has(name)) rows.push(toRow(name, null, target, 0))
  }
  return rows.sort((a, b) => a.category.localeCompare(b.category))
}

function toRow(category: string, categoryId: string | null, target: number, actual: number): BudgetRow {
  return {
    category,
    categoryId,
    target,
    actual,
    remaining: target - actual,
    fraction: target > 0 ? actual / target : 0,
    overBudget: target > 0 && actual > target,
  }
}

export interface BudgetTotals {
  target: number
  actual: number
  remaining: number
  /** actual ÷ target, 0 when no targets set. */
  fraction: number
  overBudget: boolean
}

export function budgetTotals(rows: BudgetRow[]): BudgetTotals {
  const target = rows.reduce((s, r) => s + r.target, 0)
  const actual = rows.reduce((s, r) => s + r.actual, 0)
  return {
    target,
    actual,
    remaining: target - actual,
    fraction: target > 0 ? actual / target : 0,
    overBudget: target > 0 && actual > target,
  }
}
