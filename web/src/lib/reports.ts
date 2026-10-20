// Pure aggregation helpers for the Reports page (unit-tested in reports.test.ts).
// The page only wires data + charts; all math lives here.
//
// Sign convention (see types/domain Transaction): amount > 0 = spend/outflow,
// amount < 0 = income/inflow. Grouped breakdowns are SPEND-ONLY: income rows never
// land in a spend group. Transfer exclusion covers BOTH legs of a linked transfer.

import {
  displayName,
  isTransfer,
  type Account,
  type Transaction,
  type UUID,
} from '@/types/domain'

/** One spend breakdown row. `id` is a stable key (category id / account id / merchant
 *  label); `label` is what the charts and CSV show. `total` is Σ positive amounts. */
export interface ReportGroup {
  id: string
  label: string
  total: number
  /** Series color when the grouping is category (the category's own color). */
  color?: string
}

export type GroupBy = 'category' | 'merchant' | 'account' | 'tag'

/** The money flow a report aggregates: spend = outflows (amount > 0),
 *  income = inflows (amount < 0, grouped by magnitude). */
export type ReportFlow = 'spend' | 'income'

/** Which rows enter the report. Both default ON on the page; the page always fetches
 *  includeExcluded=true and applies these client-side so toggling is instant. */
export interface ReportExcludes {
  excludeTransfers: boolean
  excludeIgnored: boolean
}

/** Drop transfer legs and/or budget-ignored rows. Transfer legs are identified by
 *  transfer_group_id != null (covers both legs). "Ignored" is exclude_from_totals=true
 *  on a NON-transfer row — user-hidden/user-excluded rows — the same split the
 *  Spending Plan totals use. */
export function applyExcludes(txns: Transaction[], opts: ReportExcludes): Transaction[] {
  return txns.filter((t) => {
    if (opts.excludeTransfers && isTransfer(t)) return false
    if (opts.excludeIgnored && t.exclude_from_totals && !isTransfer(t)) return false
    return true
  })
}

/** Stable group key for one transaction under the chosen grouping — shared by
 *  the aggregators and the drill-down filters so they can never disagree. */
export function groupKeyFor(
  t: Transaction,
  groupBy: GroupBy,
  accountsById: Map<UUID, Account>,
): { id: string; label: string; color?: string } {
  if (groupBy === 'category') {
    return {
      id: t.category_id ?? '__uncategorized__',
      label: t.categories?.name ?? 'Uncategorized',
      color: t.categories?.color,
    }
  }
  if (groupBy === 'merchant') {
    const name = displayName(t)
    return { id: name, label: name }
  }
  if (groupBy === 'tag') {
    // PocketLens's tag dimension is the auto-classified Need/Want pair.
    return {
      id: t.need_want ?? '__untagged__',
      label: t.need_want === 'need' ? 'Need' : t.need_want === 'want' ? 'Want' : 'Untagged',
    }
  }
  return { id: t.account_id, label: accountsById.get(t.account_id)?.name ?? 'Unknown account' }
}

/** Group one money flow by the chosen dimension, sorted desc by total.
 *  - category → category name ("Uncategorized" fallback), keyed by category id
 *  - merchant → merchant_name ?? description ("Unknown" fallback)
 *  - account → account name from `accountsById` ("Unknown account" fallback)
 *  - tag → Need / Want / Untagged (the classification tags)
 *  The opposite flow never enters a group; income totals are magnitudes. */
export function groupFlow(
  txns: Transaction[],
  flow: ReportFlow,
  groupBy: GroupBy,
  accountsById: Map<UUID, Account>,
): ReportGroup[] {
  const byKey = new Map<string, ReportGroup>()
  for (const t of txns) {
    if (flow === 'spend' ? t.amount <= 0 : t.amount >= 0) continue
    const mag = Math.abs(t.amount)
    const { id, label, color } = groupKeyFor(t, groupBy, accountsById)
    const row = byKey.get(id)
    if (row) row.total += mag
    else byKey.set(id, { id, label, total: mag, color })
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total)
}

/** Group SPEND by the chosen dimension, sorted desc by total.
 *  Income (amount ≤ 0) never enters a spend group. */
export function groupSpend(
  txns: Transaction[],
  groupBy: GroupBy,
  accountsById: Map<UUID, Account>,
): ReportGroup[] {
  return groupFlow(txns, 'spend', groupBy, accountsById)
}

/** Group INCOME by the chosen dimension (magnitudes), sorted desc by total.
 *  Spend (amount ≥ 0) never enters an income group. */
export function groupIncome(
  txns: Transaction[],
  groupBy: GroupBy,
  accountsById: Map<UUID, Account>,
): ReportGroup[] {
  return groupFlow(txns, 'income', groupBy, accountsById)
}

/** Keep the top `n` groups; fold the rest into one "Other" row. No "Other" row when
 *  there are ≤ n groups. Input must be sorted desc (groupSpend returns it sorted). */
export function topNWithOther(groups: ReportGroup[], n: number): ReportGroup[] {
  if (groups.length <= n) return groups
  const top = groups.slice(0, n)
  const otherTotal = groups.slice(n).reduce((s, g) => s + g.total, 0)
  return [...top, { id: '__other__', label: 'Other', total: otherTotal }]
}

/** One bucket per calendar month spanning [startISO, endISO], inclusive of both
 *  endpoint months. spend = Σ positive amounts; income = Σ |negative amounts|. */
export interface MonthlyBucket {
  monthKey: string // "2026-09"
  label: string // "Sep 2026"
  income: number
  spend: number
}

export function monthlyBuckets(
  txns: Transaction[],
  startISO: string,
  endISO: string,
): MonthlyBucket[] {
  const start = new Date(Number(startISO.slice(0, 4)), Number(startISO.slice(5, 7)) - 1, 1)
  const end = new Date(Number(endISO.slice(0, 4)), Number(endISO.slice(5, 7)) - 1, 1)
  const buckets: MonthlyBucket[] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    const y = cursor.getFullYear()
    const m = cursor.getMonth()
    buckets.push({
      monthKey: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: cursor.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
      income: 0,
      spend: 0,
    })
    cursor.setMonth(m + 1)
  }
  for (const t of txns) {
    const key = (t.effective_date ?? '').slice(0, 7)
    const b = buckets.find((x) => x.monthKey === key)
    if (!b) continue
    if (t.amount > 0) b.spend += t.amount
    else if (t.amount < 0) b.income += Math.abs(t.amount)
  }
  return buckets
}

/** Per-card spend in the (already filtered) set — accounts of type `credit` only,
 *  spend-only, sorted desc. The churner's quick view of which card took the spend. */
export interface CardSpend {
  accountId: UUID
  accountName: string
  total: number
}

export function perCardSpend(txns: Transaction[], accounts: Account[]): CardSpend[] {
  const creditNames = new Map<UUID, string>()
  for (const a of accounts) if (a.type === 'credit') creditNames.set(a.id, a.name)
  const totals = new Map<UUID, number>()
  for (const t of txns) {
    if (!creditNames.has(t.account_id)) continue
    if (t.amount <= 0) continue
    totals.set(t.account_id, (totals.get(t.account_id) ?? 0) + t.amount)
  }
  return [...totals.entries()]
    .map(([accountId, total]) => ({
      accountId,
      accountName: creditNames.get(accountId) ?? 'Unknown account',
      total,
    }))
    .sort((a, b) => b.total - a.total)
}
