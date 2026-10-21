// Register grouping for TransactionTable: pinned Pending, then calendar months.

import type { Transaction } from '@/types/domain'

export const PENDING = '__pending__'

function monthKey(iso: string): string {
  return iso.slice(0, 7)
}
export function monthLabel(key: string): string {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}
export function rowDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Pending first, then calendar months in the incoming (newest-first) order. */
export function groupRegister(txns: Transaction[]): [string, Transaction[]][] {
  const groups = new Map<string, Transaction[]>()
  if (txns.some((t) => t.pending)) groups.set(PENDING, [])
  for (const t of txns) {
    const k = t.pending ? PENDING : monthKey(t.effective_date)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(t)
  }
  return [...groups.entries()]
}

