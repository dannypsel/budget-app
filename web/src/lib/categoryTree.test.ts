import { describe, expect, it } from 'vitest'
import { categoryPath, hierarchical, incomeCategory, rootCategory } from './categoryTree'
import { makeCategory } from '@/test/factories'

const dining = makeCategory({ id: 'd', name: 'Dining & Drinks', sort_order: 1 })
const rest = makeCategory({ id: 'r', name: 'Restaurants', parent_id: 'd' })
const coffee = makeCategory({ id: 'c', name: 'Coffee Shops', parent_id: 'd' })
const auto = makeCategory({ id: 'a', name: 'Auto & Transport', sort_order: 0 })
const old = makeCategory({ id: 'o', name: 'Rent', is_active: false })
const byId = new Map([dining, rest, coffee, auto, old].map((c) => [c.id, c]))

describe('categoryTree', () => {
  it('finds the top-level parent and the full path', () => {
    expect(rootCategory(rest, byId)?.name).toBe('Dining & Drinks')
    expect(categoryPath(rest, byId)).toBe('Dining & Drinks › Restaurants')
  })

  it('orders parents by sort order with children indented beneath, skipping archived', () => {
    expect(hierarchical([dining, rest, coffee, auto, old]).map((x) => x.label)).toEqual([
      'Auto & Transport',
      'Dining & Drinks',
      '\u00a0\u00a0\u00a0Coffee Shops',
      '\u00a0\u00a0\u00a0Restaurants',
    ])
  })

  it('prefers Simplifi "Personal Income", then legacy "Income"', () => {
    const pi = makeCategory({ id: 'pi', name: 'Personal Income', kind: 'income' })
    const inc = makeCategory({ id: 'in', name: 'Income', kind: 'income' })
    expect(incomeCategory([inc, pi])?.id).toBe('pi')
    expect(incomeCategory([inc])?.id).toBe('in')
  })
})
