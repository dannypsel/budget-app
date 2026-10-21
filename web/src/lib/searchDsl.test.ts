import { describe, expect, it } from 'vitest'
import { dateWindow, matchesQuery, parseQuery, resolveDate } from './searchDsl'
import { makeCategory, makeTxn } from '@/test/factories'
import type { Account } from '@/types/domain'

const NOW = new Date(2026, 9, 20) // Oct 20, 2026 (Tuesday)
const dining = makeCategory({ id: 'c-dining', name: 'Dining & Drinks' })
const coffee = makeCategory({ id: 'c-coffee', name: 'Coffee Shops', parent_id: 'c-dining' })
const categoriesById = new Map([dining, coffee].map((c) => [c.id, c]))
const accountsById = new Map<string, Account>([
  ['a-1', { id: 'a-1', name: '360 Checking', official_name: null, mask: '1440' } as Account],
])
const ctx = { categoriesById, accountsById, now: NOW }
const match = (q: string, over: Parameters<typeof makeTxn>[0]) =>
  matchesQuery(makeTxn({ account_id: 'a-1', effective_date: '2026-10-15', ...over }), parseQuery(q), ctx)

describe('parseQuery', () => {
  it('splits constraints from free text, keeping quoted phrases whole', () => {
    const q = parseQuery('"Walmart Store" amount>100 groceries')
    expect(q.text).toEqual(['Walmart Store', 'groceries'])
    expect(q.constraints).toEqual([{ field: 'amount', operator: '>', value: '100' }])
  })

  it('maps is:/not: keywords like Simplifi REGISTER_KEYWORD_MAPPINGS', () => {
    expect(parseQuery('is:pending').constraints[0]).toEqual({ field: 'status', operator: '=', value: 'pending' })
    expect(parseQuery('not:reviewed').constraints[0]).toEqual({ field: 'reviewed', operator: '=', value: 'false' })
    expect(parseQuery('not:tags').constraints[0]).toEqual({ field: 'tags', operator: '=', value: '' })
    expect(parseQuery('not:pending').text).toEqual(['not:pending'])
  })

  it('parses ranges, ish, lists, and signed expense/income fields', () => {
    expect(parseQuery('amount:50..200').constraints[0]).toMatchObject({ operator: 'range', rangeStart: '50', rangeEnd: '200' })
    expect(parseQuery('amount=50ish').constraints[0]).toMatchObject({ operator: '~=', value: '50' })
    expect(parseQuery('payee:walmart,target').constraints[0]).toMatchObject({ values: ['walmart', 'target'] })
    expect(parseQuery('expense>500').constraints[0]).toMatchObject({ field: 'amount', sign: '-' })
  })

  it('treats unknown fields as free text', () => {
    expect(parseQuery('foo:bar').text).toEqual(['foo:bar'])
  })
})

describe('resolveDate', () => {
  it('resolves relative words, offsets, months and quarters', () => {
    expect(resolveDate('thismonth', NOW)).toEqual(['2026-10-01', '2026-10-31'])
    expect(resolveDate('this-month', NOW)).toEqual(['2026-10-01', '2026-10-31'])
    expect(resolveDate('-30d', NOW)).toEqual(['2026-09-20', '2026-10-20'])
    expect(resolveDate('2026-02', NOW)).toEqual(['2026-02-01', '2026-02-28'])
    expect(resolveDate('lastquarter', NOW)).toEqual(['2026-07-01', '2026-09-30'])
    expect(resolveDate('10/5/2026', NOW)).toEqual(['2026-10-05', '2026-10-05'])
    expect(resolveDate('banana', NOW)).toBeNull()
  })
})

describe('matchesQuery', () => {
  it('amount compares magnitude; expense/income restrict the direction', () => {
    expect(match('amount>100', { amount: 150 })).toBe(true)
    expect(match('amount>100', { amount: -150 })).toBe(true)
    expect(match('expense>100', { amount: -150 })).toBe(false)
    expect(match('income>100', { amount: -150 })).toBe(true)
    expect(match('amount=50ish', { amount: 54 })).toBe(true)
    expect(match('amount=50ish', { amount: 56 })).toBe(false)
    expect(match('amount:50..200', { amount: 120 })).toBe(true)
  })

  it('date operators use the resolved window', () => {
    expect(match('date=this-month', { effective_date: '2026-10-02' })).toBe(true)
    expect(match('date=this-month', { effective_date: '2026-09-30' })).toBe(false)
    expect(match('date>=2026-10-15', { effective_date: '2026-10-15' })).toBe(true)
    expect(match('date:2026-01-01..2026-03-31', { effective_date: '2026-02-10' })).toBe(true)
  })

  it('category= matches the category or an ancestor; != excludes', () => {
    expect(match('category="Dining & Drinks"', { categories: coffee, category_id: coffee.id })).toBe(true)
    expect(match('category!="Dining & Drinks"', { categories: coffee, category_id: coffee.id })).toBe(false)
    expect(match('is:uncategorized', { categories: null })).toBe(true)
    expect(match('is:uncategorized', { categories: dining })).toBe(false)
  })

  it('payee, account, status, reviewed, flag and free text', () => {
    expect(match('payee:walmart,target', { merchant_name: 'Target' })).toBe(true)
    expect(match('account:1440', {})).toBe(true)
    expect(match('is:pending', { pending: true })).toBe(true)
    expect(match('not:reviewed', { reviewed: true })).toBe(false)
    expect(match('is:flagged', { user_flag: 'RED' })).toBe(true)
    expect(match('flag:red', { user_flag: 'RED' })).toBe(true)
    expect(match('starbucks', { original_description: 'SQ *STARBUCKS 1234' })).toBe(true)
    expect(match('date=this-month amount>500', { amount: 600 })).toBe(true)
  })
})

describe('dateWindow', () => {
  it('narrows the fetch window from date constraints only', () => {
    expect(dateWindow(parseQuery('date=-30d amount>5'), NOW)).toEqual(['2026-09-20', '2026-10-20'])
    expect(dateWindow(parseQuery('date>=2026-01-01'), NOW)).toEqual(['2026-01-01', '9999-12-31'])
    expect(dateWindow(parseQuery('payee:x'), NOW)).toBeNull()
  })
})
