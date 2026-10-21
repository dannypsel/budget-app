// Spending / income / transfer classification for reports and the Transactions
// analysis tabs. Mirrors Simplifi's chart-of-accounts rule (see
// docs/simplifi-rea-findings.md): the CATEGORY TYPE decides income vs spending,
// not the sign, and transfers are never spending.
//
// PocketLens sign convention: amount > 0 = outflow, amount < 0 = inflow.
//   transfer  linked transfer leg (own-account moves, incl. one-sided legs), or an
//             uncategorized inflow Plaid tags as a transfer
//   excluded  user-excluded from reports (exclude_from_reports / hidden) or a category that is
//             excluded from reports
//   income    inflows on an income category; other uncategorized inflows (income-by-sign)
//   spend     every other row. A credit on a spend category (refund,
//             reimbursement) is negative spend; an outflow is never income
//             (the standing rule, commit 8286b37), even on an income category.

import { excludedFromReports, isTransfer, isTransferCategory, type Category, type Transaction } from '@/types/domain'

export type Flow = 'spend' | 'income' | 'transfer' | 'excluded'

export function flowOf(t: Transaction, category: Category | null | undefined = t.categories): Flow {
  if (isTransfer(t)) return 'transfer'
  if (excludedFromReports(t) || t.hidden) return 'excluded'
  if (category?.exclude_from_reports) return 'excluded'
  if (category) {
    if (category.kind === 'income' && !t.is_reimbursement && t.amount <= 0) return 'income'
    return 'spend'
  }
  // An uncategorized payment OUT counts as spend even when Plaid calls it a
  // transfer (Zelle/Venmo to a person) — Simplifi counts every uncategorized
  // outflow as an expense; moves between your own accounts are linked above.
  if (isTransferCategory(t) && t.amount < 0) return 'transfer'
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
