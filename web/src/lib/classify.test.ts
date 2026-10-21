import { describe, expect, it } from 'vitest'
import { flowOf, flowTotals } from './classify'
import { makeCategory, makeTxn } from '@/test/factories'

const groceries = makeCategory({ id: 'c-g', kind: 'spend' })
const paycheck = makeCategory({ id: 'c-p', name: 'Paycheck', kind: 'income' })

describe('flowOf (Simplifi: category type decides, never the sign)', () => {
  it('a refund on a spend category is negative spend, not income', () => {
    const t = makeTxn({ amount: -20, categories: groceries, category_id: groceries.id })
    expect(flowOf(t)).toBe('spend')
    expect(flowTotals([makeTxn({ amount: 100, categories: groceries }), t])).toEqual({ spend: 80, income: 0 })
  })

  it('inflows on income categories are income; an outflow is never income', () => {
    expect(flowOf(makeTxn({ amount: -1000, categories: paycheck }))).toBe('income')
    // e.g. Collin County Tax Office $6,115.08 miscategorized as Income still counts as spending
    expect(flowOf(makeTxn({ amount: 6115.08, categories: paycheck }))).toBe('spend')
    expect(flowTotals([makeTxn({ amount: -1000, categories: paycheck }), makeTxn({ amount: 50, categories: paycheck })]))
      .toEqual({ spend: 50, income: 1000 })
  })

  it('transfers are never spending or income', () => {
    expect(flowOf(makeTxn({ amount: 500, transfer_group_id: 'g', categories: groceries }))).toBe('transfer')
    expect(flowOf(makeTxn({ amount: -500, plaid_category: 'TRANSFER_IN', categories: null }))).toBe('transfer')
  })

  it('an unlinked, uncategorized payment out is spend even if Plaid says transfer (Simplifi)', () => {
    // e.g. $500 Zelle to Jing Wei: Plaid TRANSFER_OUT, not one of your accounts
    expect(flowOf(makeTxn({ amount: 500, plaid_category: 'TRANSFER_OUT', categories: null }))).toBe('spend')
  })

  it('exclusions: row-level and category-level', () => {
    expect(flowOf(makeTxn({ exclude_from_totals: true, categories: groceries }))).toBe('excluded')
    expect(flowOf(makeTxn({ categories: { ...groceries, exclude_from_reports: true } }))).toBe('excluded')
  })

  it('uncategorized falls back to the sign; reimbursements are never income', () => {
    expect(flowOf(makeTxn({ amount: 12, categories: null }))).toBe('spend')
    expect(flowOf(makeTxn({ amount: -12, categories: null }))).toBe('income')
    expect(flowOf(makeTxn({ amount: -12, categories: null, is_reimbursement: true }))).toBe('spend')
    expect(flowOf(makeTxn({ amount: -12, categories: paycheck, is_reimbursement: true }))).toBe('spend')
  })
})
