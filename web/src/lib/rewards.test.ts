import { describe, expect, it } from 'vitest'
import {
  creditShortLabel,
  filterCredits,
  newPointsBalance,
  sortCreditsByDaysRemaining,
} from './rewards'
import type { ChurnCredit } from '@/types/domain'

const base = {
  id: 'c1',
  card_id: 'card1',
  credit_name: 'Dining Credit',
  amount: 10,
  frequency: 'monthly' as const,
  used_amount: 0,
  reset_date: '2026-10-01',
  notes: null,
  auto_detect: false,
  detect_merchant_keywords: [],
  detect_amount: null,
  detect_tolerance: 0.01,
  used_at: null,
  detected_transaction_id: null,
  detected_transaction_ids: [],
  detection_source: null,
  detection_dismissed_transaction_ids: [],
  remind_days_before: 7,
  period_start_date: null,
  is_hidden: false,
  program_label: null,
  created_at: null,
} as const

function credit(overrides: Partial<ChurnCredit>): ChurnCredit {
  return { ...base, ...overrides }
}

describe('creditShortLabel', () => {
  it('prefers program_label', () => {
    expect(creditShortLabel(credit({ program_label: 'Amex', churn_cards: { card_name: 'Gold' } }))).toBe('Amex')
  })

  it('falls back to card name then credit name', () => {
    expect(creditShortLabel(credit({ churn_cards: { card_name: 'Gold' } }))).toBe('Gold')
    expect(creditShortLabel(credit({ churn_cards: null }))).toBe('Dining Credit')
  })
})

describe('filterCredits', () => {
  const used = credit({ used_amount: 10 }) // fully used
  const needs = credit({ used_amount: 0, reset_date: '2026-10-01' })
  const hidden = credit({ id: 'h', used_amount: 0, is_hidden: true })

  it('needs spending (default): unused with remaining, never hidden', () => {
    const out = filterCredits([used, needs, hidden], 'needs')
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(needs)
  })

  it('used: used credits, never hidden', () => {
    const out = filterCredits([used, needs, hidden], 'used')
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(used)
  })

  it('all: every visible credit', () => {
    expect(filterCredits([used, needs, hidden], 'all')).toHaveLength(2)
  })
})

describe('sortCreditsByDaysRemaining', () => {
  it('sorts nearest reset first; null reset dates last', () => {
    const today = new Date('2026-09-27T12:00:00')
    const far = credit({ id: 'far', reset_date: '2026-10-15' })
    const near = credit({ id: 'near', reset_date: '2026-09-28' })
    const none = credit({ id: 'none', reset_date: null })
    const out = sortCreditsByDaysRemaining([none, far, near], today)
    expect(out.map((c) => c.id)).toEqual(['near', 'far', 'none'])
  })
})

describe('newPointsBalance', () => {
  it('subtracts the spend', () => {
    expect(newPointsBalance(50000, 12000)).toBe(38000)
  })

  it('floors at zero and rejects negative spend', () => {
    expect(newPointsBalance(1000, 5000)).toBe(0)
    expect(newPointsBalance(1000, -5)).toBe(1000)
  })
})
