import { describe, expect, it } from 'vitest'
import { buildCategoryTree, buildTaxTree, flattenTree } from './reportTree'
import { buildBalanceReport, monthEndBalances, monthsBetween } from './balanceReport'
import { makeCategory, makeTxn } from '@/test/factories'
import type { Account, CategoryGroup } from '@/types/domain'

const dining = makeCategory({ id: 'dining', name: 'Dining & Drinks', group_id: null })
const coffee = makeCategory({ id: 'coffee', name: 'Coffee Shops', parent_id: 'dining' })
const parking = makeCategory({ id: 'parking', name: 'Parking', group_id: 'g-auto' })
const salary = makeCategory({ id: 'salary', name: 'Paycheck', kind: 'income' })
const charity = makeCategory({ id: 'charity', name: 'Charity & Donations' })
const cats = [dining, coffee, parking, salary, charity]
const groups: CategoryGroup[] = [{ id: 'g-auto', name: 'Auto & Transport', sort_order: 0 }]

const t = (id: string, catId: string | null, amount: number, merchant = 'M') =>
  makeTxn({ id, category_id: catId, categories: cats.find((c) => c.id === catId) ?? null, amount, merchant_name: merchant })

describe('buildCategoryTree', () => {
  const tree = buildCategoryTree(
    [t('1', 'coffee', 5), t('2', 'dining', 20), t('3', 'parking', 9), t('4', 'parking', 1), t('5', null, 3), t('6', 'salary', -100)],
    'spend',
    cats,
    groups,
  )

  it('nests group ▸ category and parent ▸ child with subtotal rollups', () => {
    expect(tree.label).toBe('Expenses')
    expect(tree.total).toBe(38)
    const auto = tree.children.find((c) => c.label === 'Auto & Transport')!
    expect(auto.total).toBe(10)
    expect(auto.children[0].label).toBe('Parking')
    expect(auto.children[0].txns).toHaveLength(2)
  })

  it('puts amounts posted on a parent into "<Parent> (Other)"', () => {
    const d = tree.children.find((c) => c.label === 'Dining & Drinks')!
    expect(d.total).toBe(25)
    expect(d.children.map((c) => [c.label, c.total])).toEqual([
      ['Dining & Drinks (Other)', 20],
      ['Coffee Shops', 5],
    ])
    expect(tree.children.find((c) => c.label === 'Uncategorized')?.total).toBe(3)
  })

  it('flattens with Total rows and respects collapsed nodes', () => {
    const rows = flattenTree(tree, new Set(['dining']))
    const labels = rows.map((r) => (r.kind === 'total' ? `Total ${r.node.label}` : r.kind === 'header' ? r.node.label : 'txn'))
    expect(labels).toContain('Total Parking')
    expect(labels).toContain('Dining & Drinks')
    expect(labels).not.toContain('Coffee Shops')
  })
})

describe('buildTaxTree', () => {
  it('splits taxable income and tax-related spend, each grouped by payee', () => {
    const tree = buildTaxTree([t('1', 'salary', -100, 'Employer'), t('2', 'salary', -50, 'Employer'), t('3', 'charity', 30, 'Church'), t('4', 'parking', 9)], cats)
    const income = tree.children.find((c) => c.label === 'Taxable income')!
    expect(income.total).toBe(150)
    expect(income.children[0].children[0]).toMatchObject({ label: 'Employer', total: 150 })
    const ded = tree.children.find((c) => c.label === 'Tax payments & deductions')!
    expect(ded.total).toBe(30)
  })
})

describe('balance report', () => {
  const accounts = [
    { id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking' },
    { id: 'sav', name: 'Savings', type: 'depository', subtype: 'savings' },
    { id: 'card', name: 'Card', type: 'credit', subtype: null },
  ] as Account[]
  const months = monthsBetween('2026-08-01', '2026-10-20')
  const balances = monthEndBalances(
    [
      { account_id: 'chk', date: '2026-07-30', current_balance: 100 },
      { account_id: 'chk', date: '2026-09-15', current_balance: 300 },
      { account_id: 'sav', date: '2026-08-31', current_balance: 1000 },
      { account_id: 'card', date: '2026-10-01', current_balance: 50 },
    ],
    months,
  )

  it('carries the latest balance forward to each month end', () => {
    expect(months.map((m) => m.end)).toEqual(['2026-08-31', '2026-09-30', '2026-10-20'])
    expect(balances.get('chk')).toEqual([100, 300, 300])
    expect(balances.get('card')).toEqual([null, null, 50])
  })

  it('net worth subtracts liabilities; savings keeps only savings accounts', () => {
    const nw = buildBalanceReport(accounts, balances, months, 'net-worth')
    expect(nw.series).toEqual([1100, 1300, 1250])
    expect(nw.rows.find((r) => r.id === 'net-worth')?.values).toEqual([1100, 1300, 1250])
    const sv = buildBalanceReport(accounts, balances, months, 'savings')
    expect(sv.series).toEqual([1000, 1000, 1000])
    expect(sv.rows.some((r) => r.label === 'Checking')).toBe(false)
  })
})
