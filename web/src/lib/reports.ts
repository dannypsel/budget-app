// Pure aggregation helpers for the Reports page (unit-tested in reports.test.ts).
// The page only wires data + charts; all math lives here.
//
// Sign convention (see types/domain Transaction): amount > 0 = outflow, amount < 0 =
// inflow. Spend vs income is decided by category type (lib/classify, Simplifi's rule):
// a refund on a spend category nets that category down rather than counting as income.
// Transfer exclusion covers BOTH legs of a linked transfer.

import { flowOf, type Flow } from '@/lib/classify'
import {
  displayName,
  isTransfer,
  type Account,
  type Transaction,
  type UUID,
} from '@/types/domain'

/** One spend breakdown row. `id` is a stable key (category id / account id / merchant
 *  label); `label` is what the charts and CSV show. `total` is the group's net flow total. */
export interface ReportGroup {
  id: string
  label: string
  total: number
  /** Series color when the grouping is category (the category's own color). */
  color?: string
}

export type GroupBy = 'category' | 'merchant' | 'account' | 'tag'

/** The money flow a report aggregates (see reportFlow). */
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
    if (opts.excludeIgnored && !isTransfer(t) && (t.exclude_from_totals || t.categories?.exclude_from_reports))
      return false
    return true
  })
}

/** The flow a row counts toward once it has passed applyExcludes. Category type
 *  decides (lib/classify); rows the user chose to keep despite being transfers or
 *  excluded fall back to the sign / their category so the toggles still work. */
export function reportFlow(t: Transaction): Exclude<Flow, 'excluded' | 'transfer'> {
  const f = flowOf(t)
  if (f === 'spend' || f === 'income') return f
  if (f === 'excluded') {
    const kept = flowOf({ ...t, exclude_from_totals: false, hidden: false }, t.categories && { ...t.categories, exclude_from_reports: false })
    if (kept === 'spend' || kept === 'income') return kept
  }
  return t.amount > 0 ? 'spend' : 'income'
}

/** Signed contribution to `flow`: outflows positive for spend, inflows positive for income. */
function signedFor(t: Transaction, flow: ReportFlow): number {
  return flow === 'spend' ? t.amount : -t.amount
}

/** One report row per split for split transactions (each carrying its split's
 *  category and amount), so category aggregation attributes splits correctly —
 *  the same rule as the category_spend view. Rows keep the parent id prefix for
 *  React keys only; never pass them to mutations. */
export function expandSplits(txns: Transaction[]): Transaction[] {
  const out: Transaction[] = []
  for (const t of txns) {
    const splits = t.transaction_splits ?? []
    if (splits.length === 0) {
      out.push(t)
      continue
    }
    for (const sp of splits) {
      out.push({
        ...t,
        id: `${t.id}:${sp.id}`,
        amount: Number(sp.amount),
        category_id: sp.category_id,
        categories: sp.categories ?? null,
        transaction_splits: [],
      })
    }
  }
  return out
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

/** Group one money flow by the chosen dimension, net of credits, sorted desc by total;
 *  groups that net to ≤ 0 (fully refunded) are dropped.
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
    if (reportFlow(t) !== flow) continue
    const amt = signedFor(t, flow)
    const { id, label, color } = groupKeyFor(t, groupBy, accountsById)
    const row = byKey.get(id)
    if (row) row.total += amt
    else byKey.set(id, { id, label, total: amt, color })
  }
  return [...byKey.values()].filter((g) => g.total > 0.005).sort((a, b) => b.total - a.total)
}

/** Group SPEND by the chosen dimension, sorted desc by total.
 *  Income-flow rows never enter a spend group. */
export function groupSpend(
  txns: Transaction[],
  groupBy: GroupBy,
  accountsById: Map<UUID, Account>,
): ReportGroup[] {
  return groupFlow(txns, 'spend', groupBy, accountsById)
}

/** Group INCOME by the chosen dimension (magnitudes), sorted desc by total.
 *  Spend-flow rows never enter an income group. */
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
 *  endpoint months. spend / income are net totals per reportFlow. */
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
    if (reportFlow(t) === 'spend') b.spend += t.amount
    else b.income -= t.amount
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
