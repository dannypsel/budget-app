// Churning-tracker math — pure functions, unit-testable without Supabase.

import type { ChurnBonus, ChurnCard, ChurnCredit } from '@/types/domain'
import { formatCurrency } from './money'

export interface BonusProgress {
  /** Qualifying outflow spend inside the bonus window. */
  spent: number
  required: number
  remaining: number
  /** 0–1+, for progress bars. */
  fraction: number
  /** Whole days from `today` until spend_by_date (negative = past). */
  daysLeft: number
}

/** Bonus progress from already-fetched qualifying spend. `today` injectable for tests. */
export function bonusProgress(
  bonus: ChurnBonus,
  qualifyingSpend: number,
  today: Date = new Date(),
): BonusProgress {
  const required = Number(bonus.spend_required)
  const spent = Math.max(0, qualifyingSpend)
  const end = new Date(`${bonus.spend_by_date}T00:00:00`)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const daysLeft = Math.round((end.getTime() - startOfToday.getTime()) / 86_400_000)
  return {
    spent,
    required,
    remaining: Math.max(0, required - spent),
    fraction: required > 0 ? spent / required : 0,
    daysLeft,
  }
}

/** The spend window a bonus counts: COALESCE(spend_start_date, card.opened_date)
 *  through spend_by_date. Returns null when no start can be determined. */
export function bonusWindow(
  card: ChurnCard,
  bonus: ChurnBonus,
): { start: string; end: string } | null {
  const start = bonus.spend_start_date ?? card.opened_date
  if (!start) return null
  return { start, end: bonus.spend_by_date }
}

export type DeadlineKind = 'bonus' | 'annual_fee' | 'cancel_by' | 'credit_expiry'

export interface ChurnDeadline {
  kind: DeadlineKind
  /** yyyy-MM-dd */
  date: string
  cardName: string
  label: string
  /** Card id — deep-links to the card detail. */
  cardId: string
}

/** Whole days from `today` until `date` (yyyy-MM-dd). Negative = past. */
export function daysUntil(date: string, today: Date = new Date()): number {
  const end = new Date(`${date}T00:00:00`)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((end.getTime() - startOfToday.getTime()) / 86_400_000)
}

/** Every upcoming deadline across cards: in-progress bonuses' spend_by_dates,
 *  annual_fee_dates, cancel_by_dates, and unused credits' reset_dates — sorted
 *  nearest-first. Past dates, completed/failed bonuses, and fully-used credits
 *  are dropped. */
export function buildChurnDeadlines(
  cards: ChurnCard[],
  bonuses: ChurnBonus[],
  credits: ChurnCredit[] = [],
  today: Date = new Date(),
): ChurnDeadline[] {
  const out: ChurnDeadline[] = []
  for (const bonus of bonuses) {
    if (bonus.status !== 'in_progress') continue
    if (daysUntil(bonus.spend_by_date, today) < 0) continue
    const card = cards.find((c) => c.id === bonus.card_id)
    out.push({
      kind: 'bonus',
      date: bonus.spend_by_date,
      cardName: card?.card_name ?? bonus.churn_cards?.card_name ?? 'Card',
      label: `Bonus: ${bonus.description}`,
      cardId: bonus.card_id,
    })
  }
  for (const credit of credits) {
    if (!credit.reset_date) continue
    if (creditIsUsed(credit) || creditRemaining(credit) <= 0) continue
    if (daysUntil(credit.reset_date, today) < 0) continue
    const card = cards.find((c) => c.id === credit.card_id)
    out.push({
      kind: 'credit_expiry',
      date: credit.reset_date,
      cardName: card?.card_name ?? credit.churn_cards?.card_name ?? 'Card',
      label: `${credit.credit_name} credit expires — ${formatCurrency(creditRemaining(credit))} unused`,
      cardId: credit.card_id,
    })
  }
  for (const card of cards) {
    if (card.annual_fee_date && daysUntil(card.annual_fee_date, today) >= 0) {
      out.push({
        kind: 'annual_fee',
        date: card.annual_fee_date,
        cardName: card.card_name,
        label: card.annual_fee != null ? `Annual fee ${card.annual_fee}` : 'Annual fee',
        cardId: card.id,
      })
    }
    if (card.cancel_by_date && daysUntil(card.cancel_by_date, today) >= 0) {
      out.push({
        kind: 'cancel_by',
        date: card.cancel_by_date,
        cardName: card.card_name,
        label: 'Decide: keep or cancel',
        cardId: card.id,
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** Remaining credit value this period. */
export function creditRemaining(credit: ChurnCredit): number {
  return Math.max(0, Number(credit.amount) - Number(credit.used_amount))
}

/** True when the credit counts as used this period — either the used amount
 *  covers the full value, or it was explicitly marked (auto or manual). */
export function creditIsUsed(credit: ChurnCredit): boolean {
  return (
    credit.detection_source != null ||
    Number(credit.used_amount) >= Number(credit.amount)
  )
}

/** Whole days from `today` until the credit's reset_date. Null when the credit
 *  has no reset date. Negative = already reset/past. */
export function creditDaysLeft(credit: ChurnCredit, today: Date = new Date()): number | null {
  if (!credit.reset_date) return null
  return daysUntil(credit.reset_date, today)
}

/** True when an unused credit deserves a nudge: its reset is within the credit's
 *  own remind window (or already past). Credits without a reset date never qualify. */
export function creditNeedsAttention(credit: ChurnCredit, today: Date = new Date()): boolean {
  if (creditIsUsed(credit)) return false
  const left = creditDaysLeft(credit, today)
  if (left == null) return false
  return left <= (credit.remind_days_before ?? 7)
}

/** Status-pill text for an unused credit, covering the reset-date edge states. */
export function creditUnusedPillText(credit: ChurnCredit, today: Date = new Date()): string {
  const left = creditDaysLeft(credit, today)
  if (left == null) return 'Unused'
  if (left < 0) return 'Unused · overdue'
  if (left === 0) return 'Unused · resets today'
  return `Unused · ${left} day${left === 1 ? '' : 's'} left`
}

/** Split a comma-separated keyword input into a clean list (drops empties). */
export function parseKeywordList(input: string): string[] {
  return input
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

/** Physical-card identity: product name + last 5 digits + owner full name (the
 *  household shares cards, so the owner only identifies which physical card to
 *  grab). Falls back to last4 when last5 was never entered. */
export function cardIdentityLine(
  card: Pick<ChurnCard, 'card_name' | 'last4' | 'owner_name' | 'last5'>,
): string {
  return [
    card.card_name,
    card.last5 ? `••••• ${card.last5}` : card.last4 ? `•••• ${card.last4}` : null,
    card.owner_name,
  ]
    .filter(Boolean)
    .join(' · ')
}
