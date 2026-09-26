import { describe, expect, it } from 'vitest'
import {
  applyExcludes,
  groupSpend,
  monthlyBuckets,
  perCardSpend,
  topNWithOther,
  type ReportExcludes,
  type ReportGroup,
} from './reports'
import type { Account, Transaction } from '@/types/domain'

let seq = 0

function txn(over: Partial<Transaction>): Transaction {
  seq += 1
  return {
    id: `t-${seq}`,
    plaid_transaction_id: `p-${seq}`,
    account_id: 'a-credit-1',
    date: '2026-09-10',
    authorized_date: null,
    effective_date: '2026-09-10',
    amount: 10,
    merchant_name: null,
    description: 'Test',
    plaid_category: null,
    plaid_category_detail: null,
    category_id: null,
    notes: null,
    pending: false,
    exclude_from_totals: false,
    transfer_group_id: null,
    transfer_kind: null,
    transfer_opt_out: false,
    hidden: false,
    is_reimbursement: false,
    merchant_city: null,
    merchant_region: null,
    merchant_country: null,
    merchant_postal_code: null,
    merchant_store_number: null,
    merchant_lat: null,
    merchant_lon: null,
    iso_currency_code: 'USD',
    categories: null,
    transaction_tags: null,
    transaction_splits: null,
    ...over,
  }
}

const acct = (id: string, name: string, type = 'credit'): Account => ({
  id,
  plaid_account_id: `plaid-${id}`,
  plaid_item_id: null,
  name,
  official_name: null,
  type,
  subtype: null,
  mask: null,
  currency: 'USD',
  is_active: true,
  display_order: 0,
})

const accountsById = new Map<string, Account>([
  ['a-credit-1', acct('a-credit-1', 'Chase Sapphire')],
  ['a-depository-1', acct('a-depository-1', 'Checking', 'depository')],
])

const bothOn: ReportExcludes = { excludeTransfers: true, excludeIgnored: true }
const bothOff: ReportExcludes = { excludeTransfers: false, excludeIgnored: false }

describe('groupSpend', () => {
  it('groups spend by category name with Uncategorized fallback, sorted desc', () => {
    const txns = [
      txn({ amount: 40, category_id: 'c-food', categories: { id: 'c-food', name: 'Food', color: '#f00', icon: 'x', parent_id: null, group_id: null, sort_order: 0, kind: 'spend' } }),
      txn({ amount: 10, category_id: 'c-food', categories: { id: 'c-food', name: 'Food', color: '#f00', icon: 'x', parent_id: null, group_id: null, sort_order: 0, kind: 'spend' } }),
      txn({ amount: 30 }), // uncategorized
      txn({ amount: 20, category_id: 'c-gas', categories: { id: 'c-gas', name: 'Gas', color: '#0f0', icon: 'x', parent_id: null, group_id: null, sort_order: 0, kind: 'spend' } }),
    ]
    const groups = groupSpend(txns, 'category', accountsById)
    expect(groups.map((g) => [g.label, g.total])).toEqual([
      ['Food', 50],
      ['Uncategorized', 30],
      ['Gas', 20],
    ])
    expect(groups[0].color).toBe('#f00')
  })

  it('excludes income (negative amounts) and zero-amount rows from spend', () => {
    const txns = [
      txn({ amount: -5000, category_id: 'c-pay', categories: { id: 'c-pay', name: 'Paycheck', color: '#0f0', icon: 'x', parent_id: null, group_id: null, sort_order: 0, kind: 'income' } }),
      txn({ amount: 0 }),
      txn({ amount: 25 }),
    ]
    const groups = groupSpend(txns, 'category', accountsById)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ label: 'Uncategorized', total: 25 })
  })

  it('groups by merchant using merchant_name ?? description', () => {
    const txns = [
      txn({ amount: 12, merchant_name: 'Whole Foods' }),
      txn({ amount: 8, merchant_name: 'Whole Foods' }),
      txn({ amount: 5, description: ' corner deli ' }),
    ]
    const groups = groupSpend(txns, 'merchant', accountsById)
    expect(groups.map((g) => [g.label, g.total])).toEqual([
      ['Whole Foods', 20],
      [' corner deli ', 5],
    ])
  })

  it('groups by account name with an unknown-account fallback', () => {
    const txns = [
      txn({ amount: 100, account_id: 'a-credit-1' }),
      txn({ amount: 50, account_id: 'a-missing' }),
    ]
    const groups = groupSpend(txns, 'account', accountsById)
    expect(groups.map((g) => [g.label, g.total])).toEqual([
      ['Chase Sapphire', 100],
      ['Unknown account', 50],
    ])
  })
})

describe('applyExcludes', () => {
  const transferLeg = txn({ amount: 500, transfer_group_id: 'g-1', exclude_from_totals: true })
  const ignoredRow = txn({ amount: 60, exclude_from_totals: true })
  const normalRow = txn({ amount: 40 })

  it('excludes both transfer legs and ignored rows when both toggles are on', () => {
    expect(applyExcludes([transferLeg, ignoredRow, normalRow], bothOn)).toEqual([normalRow])
  })

  it('keeps transfers but drops ignored non-transfer rows when only excludeIgnored is on', () => {
    expect(
      applyExcludes([transferLeg, ignoredRow, normalRow], {
        excludeTransfers: false,
        excludeIgnored: true,
      }),
    ).toEqual([transferLeg, normalRow])
  })

  it('keeps ignored rows but drops transfer legs when only excludeTransfers is on', () => {
    expect(
      applyExcludes([transferLeg, ignoredRow, normalRow], {
        excludeTransfers: true,
        excludeIgnored: false,
      }),
    ).toEqual([ignoredRow, normalRow])
  })

  it('keeps everything when both toggles are off', () => {
    expect(applyExcludes([transferLeg, ignoredRow, normalRow], bothOff)).toEqual([
      transferLeg,
      ignoredRow,
      normalRow,
    ])
  })
})

describe('topNWithOther', () => {
  const groups = (totals: number[]): ReportGroup[] =>
    totals.map((total, i) => ({ id: `g-${i}`, label: `G${i}`, total }))

  it('rolls the tail into one Other bucket', () => {
    const out = topNWithOther(groups([100, 80, 60, 40, 20]), 3)
    expect(out.map((g) => [g.label, g.total])).toEqual([
      ['G0', 100],
      ['G1', 80],
      ['G2', 60],
      ['Other', 60],
    ])
    expect(out[out.length - 1].id).toBe('__other__')
  })

  it('adds no Other bucket when there are exactly n groups', () => {
    const out = topNWithOther(groups([100, 80]), 2)
    expect(out).toHaveLength(2)
    expect(out.some((g) => g.label === 'Other')).toBe(false)
  })

  it('adds no Other bucket when there are fewer than n groups', () => {
    expect(topNWithOther(groups([100]), 12)).toHaveLength(1)
  })

  it('keeps the input order (top n stay first)', () => {
    const out = topNWithOther(groups([30, 20, 10]), 2)
    expect(out[0].total).toBe(30)
    expect(out[1].total).toBe(20)
    expect(out[2].total).toBe(10)
  })
})

describe('monthlyBuckets', () => {
  it('buckets income vs spend per month across the range', () => {
    const txns = [
      txn({ amount: 100, effective_date: '2026-07-15' }),
      txn({ amount: -2000, effective_date: '2026-07-01' }),
      txn({ amount: 50, effective_date: '2026-09-05' }),
      txn({ amount: -2000, effective_date: '2026-09-30' }),
    ]
    const out = monthlyBuckets(txns, '2026-07-01', '2026-09-30')
    expect(out.map((b) => [b.label, b.income, b.spend])).toEqual([
      ['Jul 2026', 2000, 100],
      ['Aug 2026', 0, 0],
      ['Sep 2026', 2000, 50],
    ])
  })

  it('skips rows outside the endpoint months', () => {
    const txns = [txn({ amount: 100, effective_date: '2026-06-30' })]
    const out = monthlyBuckets(txns, '2026-07-01', '2026-07-31')
    expect(out).toHaveLength(1)
    expect(out[0].spend).toBe(0)
  })

  it('includes both endpoint months for a same-month range', () => {
    const out = monthlyBuckets([], '2026-09-01', '2026-09-26')
    expect(out).toHaveLength(1)
    expect(out[0].monthKey).toBe('2026-09')
  })
})

describe('perCardSpend', () => {
  it('sums spend per credit account only, sorted desc, ignoring income', () => {
    const accounts = [
      acct('a-credit-1', 'Chase Sapphire'),
      acct('a-credit-2', 'Amex Gold'),
      acct('a-depository-1', 'Checking', 'depository'),
    ]
    const txns = [
      txn({ amount: 300, account_id: 'a-credit-1' }),
      txn({ amount: 700, account_id: 'a-credit-2' }),
      txn({ amount: 900, account_id: 'a-depository-1' }),
      txn({ amount: -50, account_id: 'a-credit-2' }), // payment/refund — not spend
    ]
    const out = perCardSpend(txns, accounts)
    expect(out.map((c) => [c.accountName, c.total])).toEqual([
      ['Amex Gold', 700],
      ['Chase Sapphire', 300],
    ])
  })

  it('returns an empty list when there are no credit accounts', () => {
    const out = perCardSpend([txn({ amount: 100 })], [acct('a-depository-1', 'Checking', 'depository')])
    expect(out).toEqual([])
  })
})
