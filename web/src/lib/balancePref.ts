// Simplifi's "Show balance" preference: account balances either include pending
// transactions (Simplifi's default, INCLUDE_PENDING) or show the bank-reported
// figure. Stored per device.

import { useSyncExternalStore } from 'react'
import { isLiabilityType } from '@/types/domain'

export type BalanceMode = 'include-pending' | 'bank'

const KEY = 'pocketlens.balanceMode'
const listeners = new Set<() => void>()

export function getBalanceMode(): BalanceMode {
  try {
    return localStorage.getItem(KEY) === 'bank' ? 'bank' : 'include-pending'
  } catch {
    return 'include-pending'
  }
}

export function setBalanceMode(mode: BalanceMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // Storage blocked — the mode still applies until reload.
  }
  listeners.forEach((l) => l())
}

export function useBalanceMode(): BalanceMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getBalanceMode,
    () => 'include-pending',
  )
}

/** Bank balance moved by pending activity. Pending amounts follow the txn sign
 *  (+ = outflow): an outflow lowers an asset and raises what a card/loan owes. */
export function withPending(type: string, bankBalance: number, pendingTotal: number): number {
  return isLiabilityType(type) ? bankBalance + pendingTotal : bankBalance - pendingTotal
}
