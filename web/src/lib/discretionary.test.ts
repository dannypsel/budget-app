import { describe, expect, it } from 'vitest'
import {
  adjustmentInsert,
  challengeIsComplete,
  challengePayoutInsert,
  challengeRangeDates,
  challengeRangeDays,
  challengeTotalPeriods,
  computeDiscretionaryStats,
  gameResultInsert,
  purchaseInsert,
  requiredCheckins,
  transferInsert,
} from './discretionary'
import type { DiscretionaryLedgerEntry } from '@/types/domain'

const base = {
  id: 'e1',
  game_type_id: null,
  winner: null,
  payout: null,
  challenge_id: null,
  note: null,
  created_at: null,
} as const

function entry(
  overrides: Partial<DiscretionaryLedgerEntry> & {
    occurred_on: string
    entry_type: DiscretionaryLedgerEntry['entry_type']
    daniel_amount: number
    sara_amount: number
  },
): DiscretionaryLedgerEntry {
  return { ...base, ...overrides }
}

describe('computeDiscretionaryStats', () => {
  it('sums per-person balances and earned/spent breakdowns', () => {
    const entries = [
      entry({ occurred_on: '2026-09-20', entry_type: 'game', winner: 'daniel', payout: 10, daniel_amount: 10, sara_amount: -10 }),
      entry({ occurred_on: '2026-09-21', entry_type: 'purchase', daniel_amount: -25, sara_amount: 0 }),
      entry({ occurred_on: '2026-09-22', entry_type: 'challenge', daniel_amount: 0, sara_amount: 50 }),
    ]
    const s = computeDiscretionaryStats(entries)
    expect(s.daniel.balance).toBe(-15)
    expect(s.daniel.earned).toBe(10)
    expect(s.daniel.spent).toBe(25)
    expect(s.sara.balance).toBe(40)
    expect(s.sara.earned).toBe(50)
    expect(s.sara.spent).toBe(0)
  })

  it('game losses are not counted as spent', () => {
    const entries = [
      entry({ occurred_on: '2026-09-20', entry_type: 'game', winner: 'daniel', payout: 10, daniel_amount: 10, sara_amount: -10 }),
    ]
    const s = computeDiscretionaryStats(entries)
    expect(s.sara.spent).toBe(0)
    expect(s.sara.balance).toBe(-10)
  })

  it('counts wins/ties/games/days-playing for game entries only', () => {
    const entries = [
      entry({ occurred_on: '2026-09-20', entry_type: 'game', winner: 'daniel', payout: 5, daniel_amount: 5, sara_amount: -5 }),
      entry({ occurred_on: '2026-09-20', entry_type: 'game', winner: 'sara', payout: 5, daniel_amount: -5, sara_amount: 5 }),
      entry({ occurred_on: '2026-09-21', entry_type: 'game', winner: 'tie', payout: 0, daniel_amount: 0, sara_amount: 0 }),
      entry({ occurred_on: '2026-09-22', entry_type: 'purchase', daniel_amount: -9, sara_amount: 0 }),
    ]
    const s = computeDiscretionaryStats(entries)
    expect(s.danielWins).toBe(1)
    expect(s.saraWins).toBe(1)
    expect(s.ties).toBe(1)
    expect(s.totalGames).toBe(3)
    expect(s.daysPlaying).toBe(2)
  })
})

describe('entry insert builders', () => {
  it('gameResultInsert: winner +payout, loser −payout', () => {
    const ins = gameResultInsert({ occurredOn: '2026-09-20', gameTypeId: 'g1', winner: 'daniel', payout: 10 })
    expect(ins.daniel_amount).toBe(10)
    expect(ins.sara_amount).toBe(-10)
    expect(ins.entry_type).toBe('game')
    expect(ins.winner).toBe('daniel')
  })

  it('gameResultInsert: tie is 0/0', () => {
    const ins = gameResultInsert({ occurredOn: '2026-09-20', gameTypeId: null, winner: 'tie', payout: 10 })
    expect(ins.daniel_amount).toBe(0)
    expect(ins.sara_amount).toBe(0)
  })

  it('purchaseInsert: negative amount for the buyer only', () => {
    const ins = purchaseInsert({ occurredOn: '2026-09-20', person: 'sara', amount: 30 })
    expect(ins.sara_amount).toBe(-30)
    expect(ins.daniel_amount).toBe(0)
  })

  it('transferInsert: moves money between balances', () => {
    const ins = transferInsert({ occurredOn: '2026-09-20', from: 'daniel', amount: 15 })
    expect(ins.daniel_amount).toBe(-15)
    expect(ins.sara_amount).toBe(15)
  })

  it('adjustmentInsert: signed amount for one person', () => {
    const ins = adjustmentInsert({ occurredOn: '2026-09-20', person: 'daniel', amount: -5 })
    expect(ins.daniel_amount).toBe(-5)
    expect(ins.sara_amount).toBe(0)
  })
})

describe('challenge completion rule', () => {
  it('daily: days in range minus grace days', () => {
    const c = { start_date: '2026-09-01', end_date: '2026-09-07', frequency: 'daily', times_per_week: null, grace_days: 1 } as const
    expect(challengeRangeDays(c)).toBe(7)
    expect(requiredCheckins(c)).toBe(6)
    expect(challengeIsComplete(c, 5)).toBe(false)
    expect(challengeIsComplete(c, 6)).toBe(true)
  })

  it('weekly: weeks × times_per_week minus grace days', () => {
    const c = { start_date: '2026-09-01', end_date: '2026-09-14', frequency: 'weekly', times_per_week: 3, grace_days: 0 } as const
    expect(challengeTotalPeriods(c)).toBe(6) // 2 weeks × 3
    expect(requiredCheckins(c)).toBe(6)
    expect(challengeIsComplete(c, 6)).toBe(true)
  })

  it('partial weeks round up', () => {
    const c = { start_date: '2026-09-01', end_date: '2026-09-09', frequency: 'weekly', times_per_week: 2, grace_days: 0 } as const
    expect(challengeTotalPeriods(c)).toBe(4) // ceil(9/7) × 2
  })

  it('grace days never push required below zero', () => {
    const c = { start_date: '2026-09-01', end_date: '2026-09-01', frequency: 'daily', times_per_week: null, grace_days: 5 } as const
    expect(requiredCheckins(c)).toBe(0)
    expect(challengeIsComplete(c, 0)).toBe(true)
  })

  it('challengePayoutInsert pays the challenge person only', () => {
    const ins = challengePayoutInsert({ id: 'c1', person: 'sara', reward: 25, title: 'Read daily' }, '2026-09-20')
    expect(ins.entry_type).toBe('challenge')
    expect(ins.challenge_id).toBe('c1')
    expect(ins.sara_amount).toBe(25)
    expect(ins.daniel_amount).toBe(0)
    expect(ins.occurred_on).toBe('2026-09-20')
  })
})

describe('challengeRangeDates', () => {
  it('lists every day in the range inclusive', () => {
    const dates = challengeRangeDates({ start_date: '2026-09-28', end_date: '2026-09-30' })
    expect(dates).toEqual(['2026-09-28', '2026-09-29', '2026-09-30'])
  })

  it('empty when end is before start', () => {
    expect(challengeRangeDates({ start_date: '2026-09-30', end_date: '2026-09-28' })).toEqual([])
  })
})
