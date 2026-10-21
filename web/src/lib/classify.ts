// Spending / income / transfer classification for reports and the Transactions
// analysis tabs. Mirrors Simplifi's chart-of-accounts rule (see
// docs/simplifi-rea-findings.md): the CATEGORY TYPE decides income vs spending,
// not the sign, and transfers are never spending.
//
// PocketLens sign convention: amount > 0 = outflow, amount < 0 = inflow.
//   transfer  linked transfer leg, or Plaid PFC transfer category
//   excluded  user-excluded (exclude_from_totals / hidden) or a category that is
//             excluded from reports
//   income    category kind 'income'; uncategorized inflows (income-by-sign)
//   spend     every other categorized row and uncategorized outflows. A credit on
//             a spend category (refund, reimbursement) is negative spend.

import { isTransfer, isTransferCategory, type Category, type Transaction } from '@/types/domain'

export type Flow = 'spend' | 'income' | 'transfer' | 'excluded'

export function flowOf(t: Transaction, category: Category | null | undefined = t.categories): Flow {
  if (isTransfer(t)) return 'transfer'
  if (t.exclude_from_totals || t.hidden) return 'excluded'
  if (category?.exclude_from_reports) return 'excluded'
  if (category) {
    if (category.kind === 'income' && !t.is_reimbursement) return 'income'
    return 'spend'
  }
  if (isTransferCategory(t)) return 'transfer'
  return t.amount < 0 && !t.is_reimbursement ? 'income' : 'spend'
}

/** Signed contribution to its flow's total: spend counts outflows positive (credits
 *  reduce it); income counts inflows positive (a debit on an income category reduces it). */
export function flowAmount(t: Transaction, flow: Flow): number {
  if (flow === 'income') return -t.amount
  if (flow === 'spend') return t.amount
  return 0
}

export interface FlowTotals {
  spend: number
  income: number
}

export function flowTotals(txns: Transaction[]): FlowTotals {
  let spend = 0
  let income = 0
  for (const t of txns) {
    const f = flowOf(t)
    if (f === 'spend') spend += t.amount
    else if (f === 'income') income -= t.amount
  }
  return { spend, income }
}
