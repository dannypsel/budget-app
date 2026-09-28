// Discretionary (Daniel-vs-Sara game/bet) math — pure functions, unit-testable
// without Supabase. These numbers are deliberately isolated: they must never
// be mixed into household totals or the spending plan.

import type {
  Challenge,
  DiscretionaryLedgerEntry,
  DiscretionaryLedgerInsert,
  DiscretionaryPerson,
} from '@/types/domain'

export interface PersonBalance {
  balance: number
  /** Sum of positive amounts. */
  earned: number
  /** Sum of |negative| purchase amounts (game losses are transfers, not spend). */
  spent: number
}

export interface DiscretionaryStats {
  daniel: PersonBalance
  sara: PersonBalance
  danielWins: number
  saraWins: number
  ties: number
  totalGames: number
  /** Distinct occurred_on among game entries. */
  daysPlaying: number
}

function emptyPerson(): PersonBalance {
  return { balance: 0, earned: 0, spent: 0 }
}

function amountFor(entry: DiscretionaryLedgerEntry, person: DiscretionaryPerson): number {
  return person === 'daniel' ? Number(entry.daniel_amount) : Number(entry.sara_amount)
}

/** Per-person balances, earned, and spent from the ledger. Balance is the true
 *  signed sum; earned/spent are the informational breakdown (earned − spent ≠
 *  balance when money moved between the two in games, bets, or transfers). */
export function computeDiscretionaryStats(
  entries: DiscretionaryLedgerEntry[],
): DiscretionaryStats {
  const stats: DiscretionaryStats = {
    daniel: emptyPerson(),
    sara: emptyPerson(),
    danielWins: 0,
    saraWins: 0,
    ties: 0,
    totalGames: 0,
    daysPlaying: 0,
  }
  const gameDays = new Set<string>()
  for (const entry of entries) {
    for (const person of ['daniel', 'sara'] as const) {
      const amt = amountFor(entry, person)
      const pb = stats[person]
      pb.balance += amt
      if (amt > 0) pb.earned += amt
      if (entry.entry_type === 'purchase' && amt < 0) pb.spent += -amt
    }
    if (entry.entry_type === 'game') {
      stats.totalGames += 1
      gameDays.add(entry.occurred_on)
      if (entry.winner === 'daniel') stats.danielWins += 1
      else if (entry.winner === 'sara') stats.saraWins += 1
      else if (entry.winner === 'tie') stats.ties += 1
    }
  }
  stats.daysPlaying = gameDays.size
  return stats
}

/** Signed ledger insert for a game result: winner +payout, loser −payout, tie 0/0. */
export function gameResultInsert(args: {
  occurredOn: string
  gameTypeId: string | null
  winner: 'daniel' | 'sara' | 'tie'
  payout: number
  note?: string
}): DiscretionaryLedgerInsert {
  const { occurredOn, gameTypeId, winner, payout, note } = args
  const p = Math.max(0, payout)
  return {
    occurred_on: occurredOn,
    entry_type: 'game',
    game_type_id: gameTypeId,
    winner,
    payout: p,
    daniel_amount: winner === 'daniel' ? p : winner === 'sara' ? -p : 0,
    sara_amount: winner === 'sara' ? p : winner === 'daniel' ? -p : 0,
    note: note?.trim() || undefined,
  }
}

/** Signed insert for a discretionary purchase: negative amount for the buyer. */
export function purchaseInsert(args: {
  occurredOn: string
  person: DiscretionaryPerson
  amount: number
  note?: string
}): DiscretionaryLedgerInsert {
  const spend = -Math.abs(args.amount)
  return {
    occurred_on: args.occurredOn,
    entry_type: 'purchase',
    daniel_amount: args.person === 'daniel' ? spend : 0,
    sara_amount: args.person === 'sara' ? spend : 0,
    note: args.note?.trim() || undefined,
  }
}

/** Signed insert for a head-to-head bet/transfer: `from` loses X, `to` gains X. */
export function transferInsert(args: {
  occurredOn: string
  from: DiscretionaryPerson
  amount: number
  note?: string
}): DiscretionaryLedgerInsert {
  const x = Math.abs(args.amount)
  return {
    occurred_on: args.occurredOn,
    entry_type: 'bet',
    daniel_amount: args.from === 'daniel' ? -x : x,
    sara_amount: args.from === 'sara' ? -x : x,
    note: args.note?.trim() || undefined,
  }
}

/** Signed insert for a manual adjustment of one person's balance. */
export function adjustmentInsert(args: {
  occurredOn: string
  person: DiscretionaryPerson
  amount: number
  note?: string
}): DiscretionaryLedgerInsert {
  const amt = args.amount
  return {
    occurred_on: args.occurredOn,
    entry_type: 'adjustment',
    daniel_amount: args.person === 'daniel' ? amt : 0,
    sara_amount: args.person === 'sara' ? amt : 0,
    note: args.note?.trim() || undefined,
  }
}

// ─── Challenges ─────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000

function toDate(s: string): Date {
  return new Date(`${s}T00:00:00`)
}

/** Inclusive whole days in the challenge range (min 1 when end ≥ start). */
export function challengeRangeDays(challenge: Pick<Challenge, 'start_date' | 'end_date'>): number {
  const days = Math.round((toDate(challenge.end_date).getTime() - toDate(challenge.start_date).getTime()) / MS_PER_DAY) + 1
  return Math.max(0, days)
}

/** Total required periods in range: days for daily; weeks × times_per_week for weekly. */
export function challengeTotalPeriods(
  challenge: Pick<Challenge, 'start_date' | 'end_date' | 'frequency' | 'times_per_week'>,
): number {
  const days = challengeRangeDays(challenge)
  if (challenge.frequency === 'daily') return days
  const weeks = Math.ceil(days / 7)
  return weeks * Math.max(1, Number(challenge.times_per_week ?? 1))
}

/** Check-ins required to complete = total periods minus grace days (min 0). */
export function requiredCheckins(
  challenge: Pick<Challenge, 'start_date' | 'end_date' | 'frequency' | 'times_per_week' | 'grace_days'>,
): number {
  return Math.max(0, challengeTotalPeriods(challenge) - Number(challenge.grace_days ?? 0))
}

/** True when the check-in count meets the completion rule. */
export function challengeIsComplete(
  challenge: Pick<Challenge, 'start_date' | 'end_date' | 'frequency' | 'times_per_week' | 'grace_days'>,
  checkinCount: number,
): boolean {
  return checkinCount >= requiredCheckins(challenge)
}

/** The idempotent payout insert for a completed challenge: +reward for the
 *  challenge's person, 0 for the other. Callers must first check the ledger for
 *  an existing row with this challenge_id (payoutChallengeIfNeeded does that). */
export function challengePayoutInsert(
  challenge: Pick<Challenge, 'id' | 'person' | 'reward' | 'title'>,
  occurredOn: string = new Date().toISOString().slice(0, 10),
): DiscretionaryLedgerInsert {
  const reward = Math.abs(Number(challenge.reward))
  return {
    occurred_on: occurredOn,
    entry_type: 'challenge',
    challenge_id: challenge.id,
    daniel_amount: challenge.person === 'daniel' ? reward : 0,
    sara_amount: challenge.person === 'sara' ? reward : 0,
    note: `Challenge completed: ${challenge.title}`,
  }
}

/** Every yyyy-MM-dd in the challenge's range (inclusive), for the check-in calendar. */
export function challengeRangeDates(challenge: Pick<Challenge, 'start_date' | 'end_date'>): string[] {
  const days = challengeRangeDays(challenge)
  if (days === 0) return []
  const start = toDate(challenge.start_date)
  const out: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * MS_PER_DAY)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  return out
}
