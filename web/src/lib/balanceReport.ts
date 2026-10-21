// Net Worth and Savings reports (Simplifi's "Net worth by month" / "Savings by
// month"): month-end balance per account, carried forward from the latest
// balance_history row on or before each month end, grouped
//   Assets ▸ Cash & Checking / Savings / Investments / Other assets ▸ account
//   Liabilities ▸ Credit cards / Loans ▸ account
// Liabilities are stored as positive amounts owed; net worth = assets − liabilities.

import type { BalancePoint } from '@/data/balanceHistory'
import type { Account, UUID } from '@/types/domain'

export interface BalanceMonth {
  key: string // "2026-09"
  label: string // "September"
  end: string // last day, yyyy-MM-dd (or today for the current month)
}

export function monthsBetween(startISO: string, endISO: string): BalanceMonth[] {
  const out: BalanceMonth[] = []
  const cursor = new Date(Number(startISO.slice(0, 4)), Number(startISO.slice(5, 7)) - 1, 1)
  const last = new Date(Number(endISO.slice(0, 4)), Number(endISO.slice(5, 7)) - 1, 1)
  while (cursor <= last) {
    const y = cursor.getFullYear()
    const m = cursor.getMonth()
    const monthEnd = new Date(y, m + 1, 0)
    const endIso = `${y}-${String(m + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`
    out.push({
      key: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: cursor.toLocaleDateString(undefined, { month: 'long' }),
      end: endIso < endISO ? endIso : endISO,
    })
    cursor.setMonth(m + 1)
  }
  return out
}

/** account id → month-end balance per month (null before the first known row). */
export function monthEndBalances(points: BalancePoint[], months: BalanceMonth[]): Map<UUID, (number | null)[]> {
  const byAccount = new Map<UUID, BalancePoint[]>()
  for (const p of points) {
    if (p.current_balance == null) continue
    const list = byAccount.get(p.account_id) ?? []
    list.push(p)
    byAccount.set(p.account_id, list)
  }
  const out = new Map<UUID, (number | null)[]>()
  for (const [id, list] of byAccount) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    let i = 0
    let last: number | null = null
    out.set(
      id,
      months.map((m) => {
        while (i < list.length && list[i].date <= m.end) last = list[i++].current_balance
        return last
      }),
    )
  }
  return out
}

export type BalanceSectionKey = 'cash' | 'savings' | 'investments' | 'other-assets' | 'credit' | 'loans'

export const BALANCE_SECTION_TITLE: Record<BalanceSectionKey, string> = {
  cash: 'Cash & Checking',
  savings: 'Savings',
  investments: 'Investments',
  'other-assets': 'Other assets',
  credit: 'Credit cards',
  loans: 'Loans',
}

export function balanceSection(a: Pick<Account, 'type' | 'subtype'>): BalanceSectionKey {
  if (a.type === 'credit') return 'credit'
  if (a.type === 'loan') return 'loans'
  if (a.type === 'investment') return 'investments'
  if (a.type === 'depository') return a.subtype === 'savings' || a.subtype === 'money market' || a.subtype === 'cd' ? 'savings' : 'cash'
  return 'other-assets'
}

export interface BalanceRow {
  id: string
  label: string
  /** null = no balance recorded yet for that month. */
  values: (number | null)[]
  depth: number
  kind: 'group' | 'section' | 'account' | 'total'
}

export interface BalanceReport {
  rows: BalanceRow[]
  /** Headline series: net worth (assets − liabilities) or total savings; null before any data. */
  series: (number | null)[]
}

/** Build the report table. `mode: 'savings'` keeps only savings-section accounts. */
export function buildBalanceReport(
  accounts: Account[],
  balances: Map<UUID, (number | null)[]>,
  months: BalanceMonth[],
  mode: 'net-worth' | 'savings',
): BalanceReport {
  const empty = (): (number | null)[] => months.map(() => null)
  const add = (a: (number | null)[], b: (number | null)[]) =>
    a.map((v, i) => (v == null && b[i] == null ? null : (v ?? 0) + (b[i] ?? 0)))
  const sections = new Map<BalanceSectionKey, { accounts: { a: Account; v: (number | null)[] }[] }>()
  for (const a of accounts) {
    const v = balances.get(a.id)
    if (!v || v.every((x) => x == null)) continue
    const key = balanceSection(a)
    if (mode === 'savings' && key !== 'savings') continue
    const s = sections.get(key) ?? { accounts: [] }
    s.accounts.push({ a, v })
    sections.set(key, s)
  }

  const rows: BalanceRow[] = []
  const groupTotals = { assets: empty(), liabilities: empty() }
  const groups: ['assets' | 'liabilities', BalanceSectionKey[]][] = [
    ['assets', ['cash', 'savings', 'investments', 'other-assets']],
    ['liabilities', ['credit', 'loans']],
  ]
  for (const [g, keys] of groups) {
    const present = keys.filter((k) => sections.has(k))
    if (present.length === 0) continue
    rows.push({ id: g, label: g === 'assets' ? 'Assets' : 'Liabilities', values: [], depth: 0, kind: 'group' })
    for (const k of present) {
      const s = sections.get(k)!
      rows.push({ id: `${g}:${k}`, label: BALANCE_SECTION_TITLE[k], values: [], depth: 1, kind: 'section' })
      let total = empty()
      for (const { a, v } of s.accounts.sort((x, y) => x.a.name.localeCompare(y.a.name))) {
        rows.push({ id: a.id, label: a.name, values: v, depth: 2, kind: 'account' })
        total = add(total, v)
      }
      rows.push({ id: `${g}:${k}:total`, label: `Total ${BALANCE_SECTION_TITLE[k]}`, values: total, depth: 2, kind: 'total' })
      groupTotals[g] = add(groupTotals[g], total)
    }
    rows.push({ id: `${g}:total`, label: g === 'assets' ? 'Total Assets' : 'Total Liabilities', values: groupTotals[g], depth: 1, kind: 'total' })
  }
  const series = groupTotals.assets.map((v, i) => {
    const l = groupTotals.liabilities[i]
    return v == null && l == null ? null : (v ?? 0) - (l ?? 0)
  })
  if (mode === 'net-worth' && rows.length > 0) {
    rows.push({ id: 'net-worth', label: 'Net Worth', values: series, depth: 0, kind: 'total' })
  }
  return { rows, series }
}

