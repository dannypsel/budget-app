import { describe, expect, it } from 'vitest'
import {
  bonusProgress,
  bonusWindow,
  buildChurnDeadlines,
  creditDaysLeft,
  creditIsUsed,
  creditNeedsAttention,
  creditRemaining,
  creditUnusedPillText,
  daysUntil,
  isCardBillPayment,
  netQualifyingSpend,
  parseKeywordList,
} from './churning'
import type { ChurnBonus, ChurnCard, ChurnCredit } from '@/types/domain'

const card = (over: Partial<ChurnCard> = {}): ChurnCard => ({
  id: 'card-1',
  card_name: 'Test Card',
  issuer: null,
  last4: null,
  opened_date: '2026-01-15',
  annual_fee: null,
  annual_fee_date: null,
  cancel_by_date: null,
  notes: null,
  account_id: null,
  ...over,
})
const bonus = (over: Partial<ChurnBonus> = {}): ChurnBonus => ({
  id: 'bonus-1',
  card_id: 'card-1',
  description: '80k points',
  spend_required: 4000,
  spend_start_date: null,
  spend_by_date: '2026-04-15',
  bonus_value: null,
  status: 'in_progress',
  ...over,
})

describe('bonusProgress', () => {
  const today = new Date(2026, 2, 1) // Mar 1 → 45 days to Apr 15

  it('computes fraction/remaining/days-left', () => {
    const p = bonusProgress(bonus(), 1000, today)
    expect(p.spent).toBe(1000)
    expect(p.required).toBe(4000)
    expect(p.remaining).toBe(3000)
    expect(p.fraction).toBeCloseTo(0.25, 5)
    expect(p.daysLeft).toBe(45)
  })

  it('clamps remaining at zero when overspent', () => {
    const p = bonusProgress(bonus(), 5000, today)
    expect(p.remaining).toBe(0)
    expect(p.fraction).toBeCloseTo(1.25, 5)
  })

  it('goes negative past the deadline', () => {
    const p = bonusProgress(bonus(), 0, new Date(2026, 3, 20))
    expect(p.daysLeft).toBe(-5)
  })
})

describe('bonusWindow', () => {
  it('prefers spend_start_date over opened_date', () => {
    expect(
      bonusWindow(card(), bonus({ spend_start_date: '2026-02-01' })),
    ).toEqual({ start: '2026-02-01', end: '2026-04-15' })
  })
  it('falls back to the card opened_date', () => {
    expect(bonusWindow(card(), bonus())).toEqual({ start: '2026-01-15', end: '2026-04-15' })
  })
  it('returns null when neither date exists', () => {
    expect(bonusWindow(card({ opened_date: null }), bonus())).toBeNull()
  })
})

describe('daysUntil', () => {
  it('counts whole days, 0 for today', () => {
    const today = new Date(2026, 8, 25)
    expect(daysUntil('2026-09-25', today)).toBe(0)
    expect(daysUntil('2026-09-26', today)).toBe(1)
    expect(daysUntil('2026-09-24', today)).toBe(-1)
  })
})

describe('buildChurnDeadlines', () => {
  const today = new Date(2026, 8, 25)

  it('merges bonus/fee/cancel deadlines nearest-first, dropping past + done', () => {
    const cards = [
      card({
        id: 'c1',
        card_name: 'Alpha',
        annual_fee_date: '2026-12-01',
        annual_fee: 95,
        cancel_by_date: '2026-10-01',
      }),
      card({ id: 'c2', card_name: 'Beta', annual_fee_date: '2026-09-01' }), // past → dropped
    ]
    const bonuses = [
      bonus({ id: 'b1', card_id: 'c1', spend_by_date: '2026-09-28', description: '60k pts' }),
      bonus({ id: 'b2', card_id: 'c2', spend_by_date: '2026-10-15', status: 'completed' }), // done → dropped
      bonus({ id: 'b3', card_id: 'c2', spend_by_date: '2026-09-20', status: 'in_progress' }), // past → dropped
    ]
    const out = buildChurnDeadlines(cards, bonuses, [], today)
    expect(out.map((d) => [d.kind, d.date])).toEqual([
      ['bonus', '2026-09-28'],
      ['cancel_by', '2026-10-01'],
      ['annual_fee', '2026-12-01'],
    ])
    expect(out[0].cardName).toBe('Alpha')
    expect(out[0].cardId).toBe('c1')
  })
})

describe('creditRemaining', () => {
  const credit = (over: Partial<ChurnCredit> = {}): ChurnCredit => ({
    id: 'cr-1',
    card_id: 'card-1',
    credit_name: 'Dining',
    amount: 300,
    frequency: 'annual',
    used_amount: 0,
    reset_date: null,
    notes: null,
    auto_detect: true,
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
    ...over,
  })

  it('subtracts used from amount, clamped at zero', () => {
    expect(creditRemaining(credit({ used_amount: 120 }))).toBe(180)
    expect(creditRemaining(credit({ used_amount: 400 }))).toBe(0)
  })

  describe('creditIsUsed', () => {
    it('is false for a fresh credit', () => {
      expect(creditIsUsed(credit())).toBe(false)
    })
    it('is true when used_amount covers the full amount', () => {
      expect(creditIsUsed(credit({ used_amount: 300 }))).toBe(true)
    })
    it('is false for partially-used credits — dollars, not marks, decide', () => {
      expect(creditIsUsed(credit({ detection_source: 'auto', used_amount: 20 }))).toBe(false)
      expect(creditIsUsed(credit({ detection_source: 'manual', used_amount: 0 }))).toBe(false)
      expect(creditIsUsed(credit({ detection_source: 'manual', used_amount: 299.99 }))).toBe(false)
    })
  })

  describe('creditDaysLeft / creditUnusedPillText', () => {
    const today = new Date(2026, 8, 25)
    it('counts whole days until reset, null without a reset date', () => {
      expect(creditDaysLeft(credit({ reset_date: '2026-09-30' }), today)).toBe(5)
      expect(creditDaysLeft(credit({ reset_date: '2026-09-25' }), today)).toBe(0)
      expect(creditDaysLeft(credit({ reset_date: '2026-09-20' }), today)).toBe(-5)
      expect(creditDaysLeft(credit({ reset_date: null }), today)).toBeNull()
    })
    it('covers the unused pill edge states', () => {
      expect(creditUnusedPillText(credit({ reset_date: null }), today)).toBe('Unused')
      expect(creditUnusedPillText(credit({ reset_date: '2026-09-20' }), today)).toBe(
        'Unused · overdue',
      )
      expect(creditUnusedPillText(credit({ reset_date: '2026-09-25' }), today)).toBe(
        'Unused · resets today',
      )
      expect(creditUnusedPillText(credit({ reset_date: '2026-09-26' }), today)).toBe(
        'Unused · 1 day left',
      )
      expect(creditUnusedPillText(credit({ reset_date: '2026-09-30' }), today)).toBe(
        'Unused · 5 days left',
      )
    })
  })

  describe('creditNeedsAttention', () => {
    const today = new Date(2026, 8, 25)
    it('fires inside the credit’s own remind window', () => {
      expect(
        creditNeedsAttention(credit({ reset_date: '2026-10-01', remind_days_before: 7 }), today),
      ).toBe(true) // 6 days left ≤ 7
      expect(
        creditNeedsAttention(credit({ reset_date: '2026-10-10', remind_days_before: 7 }), today),
      ).toBe(false) // 15 days left > 7
    })
    it('fires for overdue credits and skips used ones or those without a reset', () => {
      expect(creditNeedsAttention(credit({ reset_date: '2026-09-20' }), today)).toBe(true)
      expect(
        creditNeedsAttention(
          credit({ reset_date: '2026-09-26', used_amount: 300 }),
          today,
        ),
      ).toBe(false)
      expect(creditNeedsAttention(credit({ reset_date: null }), today)).toBe(false)
    })
    it('respects a custom remind window', () => {
      expect(
        creditNeedsAttention(credit({ reset_date: '2026-10-01', remind_days_before: 30 }), today),
      ).toBe(true)
    })
  })

  describe('buildChurnDeadlines credit_expiry', () => {
    const today = new Date(2026, 8, 25)
    const cards = [card({ id: 'c1', card_name: 'Alpha' })]
    it('adds unused credits with future resets, sorted with the rest', () => {
      const credits = [
        credit({ id: 'cr1', card_id: 'c1', credit_name: 'Dining', amount: 300, reset_date: '2026-10-05' }),
        credit({
          id: 'cr2',
          card_id: 'c1',
          credit_name: 'Airline',
          amount: 200,
          used_amount: 50,
          reset_date: '2026-09-28',
        }),
      ]
      const out = buildChurnDeadlines(cards, [], credits, today)
      expect(out.map((d) => [d.kind, d.date, d.cardId])).toEqual([
        ['credit_expiry', '2026-09-28', 'c1'],
        ['credit_expiry', '2026-10-05', 'c1'],
      ])
      expect(out[0].label).toBe('Airline credit expires — $150.00 unused')
      expect(out[0].cardName).toBe('Alpha')
    })
    it('drops used, past-reset, and dateless credits', () => {
      const credits = [
        credit({ id: 'u1', card_id: 'c1', credit_name: 'Used', reset_date: '2026-10-05', used_amount: 300, detection_source: 'auto' }),
        credit({ id: 'u2', card_id: 'c1', credit_name: 'Full', reset_date: '2026-10-05', used_amount: 300 }),
        credit({ id: 'u3', card_id: 'c1', credit_name: 'Past', reset_date: '2026-09-01' }),
        credit({ id: 'u4', card_id: 'c1', credit_name: 'NoDate', reset_date: null }),
      ]
      expect(buildChurnDeadlines(cards, [], credits, today)).toEqual([])
    })
    it('falls back to the joined card name when the card list lacks the card', () => {
      const credits = [
        credit({
          id: 'cr9',
          card_id: 'c9',
          credit_name: 'Dining',
          reset_date: '2026-10-05',
          churn_cards: { card_name: 'Joined Card' },
        }),
      ]
      const out = buildChurnDeadlines(cards, [], credits, today)
      expect(out[0].cardName).toBe('Joined Card')
      expect(out[0].cardId).toBe('c9')
    })
  })
})

describe('parseKeywordList', () => {
  it('splits on commas, trims, and drops empties', () => {
    expect(parseKeywordList('grubhub, doordash ,,  uber eats ')).toEqual([
      'grubhub',
      'doordash',
      'uber eats',
    ])
  })
  it('returns [] for blank input', () => {
    expect(parseKeywordList('  , ')).toEqual([])
  })
})

describe('netQualifyingSpend', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    amount: 100,
    plaid_category_detail: null,
    merchant_name: 'WHOLE FOODS',
    description: 'WHOLE FOODS',
    ...over,
  })

  it('sums outflows', () => {
    expect(netQualifyingSpend([row({ amount: 100 }), row({ amount: 25.5 })])).toBe(125.5)
  })
  it('subtracts reimbursements/refunds', () => {
    expect(
      netQualifyingSpend([
        row({ amount: 500 }),
        row({ amount: -120, merchant_name: 'AMEX', description: 'AMEX Airline Fee Reimbursement' }),
        row({ amount: -30, merchant_name: 'DELTA', description: 'Refund' }),
      ]),
    ).toBe(350)
  })
  it('ignores bill payments identified by Plaid detail', () => {
    expect(
      netQualifyingSpend([
        row({ amount: 500 }),
        row({
          amount: -500,
          plaid_category_detail: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
          merchant_name: 'AMEX EPAYMENT',
          description: 'ACH PMT',
        }),
      ]),
    ).toBe(500)
  })
  it('ignores bill payments by name fallback when detail is missing', () => {
    expect(
      netQualifyingSpend([
        row({ amount: 500 }),
        row({ amount: -500, merchant_name: 'AMEX EPAYMENT ACH PMT', description: '' }),
      ]),
    ).toBe(500)
  })
  it('never goes negative', () => {
    expect(netQualifyingSpend([row({ amount: -50, description: 'Refund' })])).toBe(0)
  })
  it('rounds to cents', () => {
    expect(netQualifyingSpend([row({ amount: 10.005 })])).toBe(10.01)
  })
})

describe('isCardBillPayment', () => {
  it('flags Plaid credit-card-payment detail', () => {
    expect(
      isCardBillPayment({ plaid_category_detail: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
    ).toBe(true)
  })
  it('does not flag other details', () => {
    expect(
      isCardBillPayment({
        plaid_category_detail: 'TRAVEL_AIRLINES',
        description: 'Delta Air Lines Reimbursement',
      }),
    ).toBe(false)
  })
  it('sniffs autopay phrasing when detail is null', () => {
    expect(isCardBillPayment({ description: 'Online Payment Thank You' })).toBe(true)
    expect(isCardBillPayment({ description: 'AMEX Dining Credit Reimbursement' })).toBe(false)
  })
})
