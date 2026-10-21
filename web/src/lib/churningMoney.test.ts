import { describe, expect, it } from 'vitest'
import { annualFeeCandidates, annualFeesCategory, churningCategoryIds, churningSummary } from './churningMoney'
import { flowOf } from './classify'
import { applyExcludes } from './reports'
import { makeTxn } from '@/test/factories'
import type { Account, Category } from '@/types/domain'

const cat = (id: string, name: string, parent_id: string | null = null, extra: Partial<Category> = {}): Category => ({
  id,
  name,
  color: '#000',
  icon: '',
  parent_id,
  group_id: null,
  sort_order: 0,
  kind: 'spend',
  ...extra,
})

const churning = cat('c-ch', 'Churning', null, { exclude_from_reports: true })
const fees = cat('c-fee', 'Annual Fees', 'c-ch', { exclude_from_reports: true })
const sales = cat('c-sale', 'Credit Sales', 'c-ch', { exclude_from_reports: true, kind: 'income' })
const feesAndCharges = cat('c-fc', 'Fees & Charges')
const categories = [churning, fees, sales, feesAndCharges]

const acct = (id: string, name: string, type: string): Account => ({
  id,
  plaid_account_id: `p-${id}`,
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
const accountsById = new Map([
  ['a-amex', acct('a-amex', 'Amex Platinum', 'credit')],
  ['a-chk', acct('a-chk', 'Checking', 'depository')],
])

describe('churningSummary', () => {
  it('nets annual fees (refunds included) against money made', () => {
    const rows = [
      makeTxn({ amount: 695, category_id: 'c-fee', account_id: 'a-amex', categories: fees }),
      makeTxn({ amount: -95, category_id: 'c-fee', account_id: 'a-amex', categories: fees }), // fee refund
      makeTxn({ amount: -400, category_id: 'c-sale', account_id: 'a-chk', categories: sales }),
      makeTxn({ amount: -50, category_id: 'c-sale', account_id: 'a-chk', categories: sales, hidden: true }),
      makeTxn({ amount: 30, category_id: 'c-fc', account_id: 'a-amex', categories: feesAndCharges }),
    ]
    const s = churningSummary(rows, categories, accountsById)
    expect(s.fees).toBe(600)
    expect(s.earned).toBe(400)
    expect(s.net).toBe(-200)
    expect(s.txns).toHaveLength(3)
    expect(s.bySubcategory.map((l) => [l.label, l.net])).toEqual([
      ['Annual Fees', -600],
      ['Credit Sales', 400],
    ])
    expect(s.byAccount.map((l) => [l.label, l.net])).toEqual([
      ['Amex Platinum', -600],
      ['Checking', 400],
    ])
  })

  it('has nothing to add up without a Churning category', () => {
    expect(churningCategoryIds([feesAndCharges]).size).toBe(0)
    expect(annualFeesCategory([feesAndCharges])).toBeNull()
  })
})

describe('churning is excluded from spending and reports', () => {
  it('a Churning fee is neither spend nor income', () => {
    const t = makeTxn({ amount: 695, category_id: 'c-fee', categories: fees })
    expect(flowOf(t)).toBe('excluded')
    expect(applyExcludes([t], { excludeTransfers: true, excludeIgnored: true })).toEqual([])
  })
})

describe('annualFeeCandidates', () => {
  it('finds card annual fees outside Churning, nothing else', () => {
    const hit = makeTxn({ id: 'f1', amount: 95, description: 'Annual Membership Fee', account_id: 'a-amex', category_id: 'c-fc', categories: feesAndCharges })
    const hit2 = makeTxn({ id: 'f2', amount: 895, description: 'Membership Fee Xxxx1007', account_id: 'a-amex' })
    const rows = [
      hit,
      hit2,
      makeTxn({ amount: 39, description: 'Late Fee', account_id: 'a-amex' }),
      makeTxn({ amount: 95, description: 'Annual Fee', account_id: 'a-chk' }), // not a card
      makeTxn({ amount: 695, description: 'Annual Fee', account_id: 'a-amex', category_id: 'c-fee', categories: fees }), // already churning
      makeTxn({ amount: 95, description: 'Annual Fee', account_id: 'a-amex', transfer_group_id: 'g1' }),
    ]
    expect(annualFeeCandidates(rows, categories, accountsById).map((t) => t.id)).toEqual([hit.id, hit2.id])
  })
})
