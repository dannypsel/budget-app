// Churning money: annual fees paid vs. money made (credits sold, bonuses,
// referrals). Churning lives under its own top-level "Churning" category whose
// categories are excluded from reports, so it never distorts "where our money
// goes" — this module is the one place that adds it back up.
//
// Sign convention: amount > 0 = outflow, amount < 0 = inflow.

import { isTransfer, type Account, type Category, type Transaction, type UUID } from '@/types/domain'

export const CHURNING_ROOT = 'Churning'
export const ANNUAL_FEES = 'Annual Fees'

/** The subcategories set up under Churning. Kind only guides pickers — the
 *  churning totals go by sign. */
export const CHURNING_SUBCATEGORIES: { name: string; kind: Category['kind'] }[] = [
  { name: ANNUAL_FEES, kind: 'spend' },
  { name: 'Credit Sales', kind: 'income' },
  { name: 'Bonuses & Referrals', kind: 'income' },
]

/** The top-level Churning category, if the user has one. */
export function churningRoot(categories: Category[]): Category | null {
  return categories.find((c) => !c.parent_id && c.name.trim().toLowerCase() === CHURNING_ROOT.toLowerCase()) ?? null
}

/** Ids of Churning and every category beneath it. */
export function churningCategoryIds(categories: Category[]): Set<UUID> {
  const root = churningRoot(categories)
  const ids = new Set<UUID>()
  if (!root) return ids
  ids.add(root.id)
  let grew = true
  while (grew) {
    grew = false
    for (const c of categories) {
      if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) {
        ids.add(c.id)
        grew = true
      }
    }
  }
  return ids
}

/** Churning › Annual Fees, if it exists. */
export function annualFeesCategory(categories: Category[]): Category | null {
  const root = churningRoot(categories)
  if (!root) return null
  return categories.find((c) => c.parent_id === root.id && c.name.trim().toLowerCase() === ANNUAL_FEES.toLowerCase()) ?? null
}

export interface ChurningLine {
  id: string
  label: string
  /** Positive = money made, negative = money spent (net of refunds). */
  net: number
  txns: Transaction[]
}

export interface ChurningSummary {
  /** Net annual fees paid (fee refunds reduce it). Positive = cost. */
  fees: number
  /** Net money in from everything else under Churning. Positive = made. */
  earned: number
  /** earned − fees. */
  net: number
  bySubcategory: ChurningLine[]
  byAccount: ChurningLine[]
  txns: Transaction[]
}

/** Totals for every churning-category row in `txns` (hidden rows skipped). The
 *  churning category is the user's explicit choice, so a row counts here even if
 *  it is also excluded from reports or linked as a transfer. */
export function churningSummary(
  txns: Transaction[],
  categories: Category[],
  accountsById: Map<UUID, Account>,
): ChurningSummary {
  const ids = churningCategoryIds(categories)
  const byId = new Map(categories.map((c) => [c.id, c]))
  const feesId = annualFeesCategory(categories)?.id
  const rows = txns.filter((t) => !t.hidden && t.category_id != null && ids.has(t.category_id))
  const sub = new Map<string, ChurningLine>()
  const acct = new Map<string, ChurningLine>()
  let fees = 0
  let earned = 0
  for (const t of rows) {
    if (t.category_id === feesId) fees += t.amount
    else earned -= t.amount
    const c = byId.get(t.category_id!)
    const subKey = c?.id ?? 'other'
    const s = sub.get(subKey) ?? { id: subKey, label: c && c.parent_id ? c.name : 'Churning (other)', net: 0, txns: [] }
    s.net -= t.amount
    s.txns.push(t)
    sub.set(subKey, s)
    const a = acct.get(t.account_id) ?? { id: t.account_id, label: accountsById.get(t.account_id)?.name ?? 'Unknown account', net: 0, txns: [] }
    a.net -= t.amount
    a.txns.push(t)
    acct.set(t.account_id, a)
  }
  const sorted = (m: Map<string, ChurningLine>) => [...m.values()].sort((x, y) => x.net - y.net || x.label.localeCompare(y.label))
  return { fees, earned, net: earned - fees, bySubcategory: sorted(sub), byAccount: sorted(acct), txns: rows }
}

/** Card annual fees by statement text: "Annual Fee", "Annual Membership Fee",
 *  "Membership Fee Xxxx1007", "Renewal fee"… (and their reversals). */
export const ANNUAL_FEE_PATTERN = /\b(annual|membership|renewal)\s+(membership\s+)?fee\b|\bannual\s+card\s*member\s+fee\b/i

/** Annual-fee rows on credit cards that aren't in Churning yet — the "move these
 *  in" suggestions. Transfers and hidden rows are never suggested. */
export function annualFeeCandidates(
  txns: Transaction[],
  categories: Category[],
  accountsById: Map<UUID, Account>,
): Transaction[] {
  const ids = churningCategoryIds(categories)
  return txns.filter((t) => {
    if (t.hidden || isTransfer(t)) return false
    if (t.category_id != null && ids.has(t.category_id)) return false
    if (accountsById.get(t.account_id)?.type !== 'credit') return false
    const text = [t.original_description, t.description, t.merchant_name].filter(Boolean).join(' ')
    return ANNUAL_FEE_PATTERN.test(text)
  })
}
