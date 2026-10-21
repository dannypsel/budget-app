// "All Accounts" balance shared by the Transactions page header card: the same
// signed sum the dashboard Accounts panel shows (liabilities count negative,
// inactive accounts excluded).

import { isLiabilityType } from '@/types/domain'

interface Balanced {
  type: string
  is_active?: boolean
  currentBalance?: number | null
}

export function allAccountsTotal(accounts: Balanced[]): { total: number; count: number } {
  let total = 0
  let count = 0
  for (const a of accounts) {
    if (a.is_active === false) continue
    count += 1
    const b = a.currentBalance ?? 0
    total += isLiabilityType(a.type) ? -b : b
  }
  return { total, count }
}
