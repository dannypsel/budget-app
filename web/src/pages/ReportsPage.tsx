// Reports — Simplifi-style report picker. Report types mirror Simplifi's
// gallery: Spending, Spending Summary, Income, Income Summary, Income &
// Expense, Monthly Summary — plus PocketLens's own Forecast (live
// spending-plan baseline projection). Reports can be saved (name + type +
// range + grouping + filters, kept in localStorage) and reopened from the
// home. Trailing 12 months is the default range. Sign convention: amount > 0
// = spend, amount < 0 = income. Transfer and ignored exclusions are applied
// client-side so toggling is instant.

import { useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ArrowLeft, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  useAccountsWithBalance,
  useCategories,
  useTransactionsRange,
} from '@/data/hooks'
import {
  applyExcludes,
  groupFlow,
  groupKeyFor,
  groupSpend,
  monthlyBuckets,
  topNWithOther,
  type GroupBy,
  type ReportFlow,
  type ReportGroup,
} from '@/lib/reports'
import { formatCurrency } from '@/lib/money'
import { toISODate } from '@/lib/dates'
import {
  chartTooltipItemStyle,
  chartTooltipLabelStyle,
  chartTooltipStyle,
} from '@/lib/chartTooltip'
import { downloadCsv, rowsToCsv } from '@/lib/exportCsv'
import { useHorizontalWheel } from '@/hooks/useHorizontalWheel'
import { cn } from '@/lib/utils'
import { displayName, type Transaction, type UUID } from '@/types/domain'
import ForecastSection from '@/components/reports/ForecastSection'

type ReportId =
  | 'spending'
  | 'summary'
  | 'income'
  | 'income-summary'
  | 'income-expense'
  | 'monthly-summary'
  | 'forecast'

// ─── date presets ─────────────────────────────────────────────────────────────

type Preset =
  | 'this-month'
  | 'last-month'
  | 'qtd'
  | 'last-quarter'
  | 'last-year'
  | 'last-3'
  | 'last-6'
  | 'last-12'
  | 'ytd'
  | 'custom'

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'this-month', label: 'Month to date' },
  { value: 'qtd', label: 'Quarter to date' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-quarter', label: 'Last quarter' },
  { value: 'last-year', label: 'Last year' },
  { value: 'last-3', label: 'Recent 3 months' },
  { value: 'last-6', label: 'Recent 6 months' },
  { value: 'last-12', label: 'Recent 12 months' },
  { value: 'custom', label: 'Custom' },
]

interface Range {
  start: string // yyyy-MM-dd
  end: string // yyyy-MM-dd
}

function rangeFor(preset: Preset, now: Date, customStart: string, customEnd: string): Range {
  const y = now.getFullYear()
  const m = now.getMonth()
  const firstOf = (yy: number, mm: number) => toISODate(new Date(yy, mm, 1))
  const lastDayOf = (yy: number, mm: number) => toISODate(new Date(yy, mm + 1, 0))
  switch (preset) {
    case 'this-month':
      return { start: firstOf(y, m), end: toISODate(now) }
    case 'last-month':
      return { start: firstOf(y, m - 1), end: lastDayOf(y, m - 1) }
    case 'qtd': {
      const qStart = Math.floor(m / 3) * 3
      return { start: firstOf(y, qStart), end: toISODate(now) }
    }
    case 'last-quarter': {
      const qStart = Math.floor(m / 3) * 3
      return { start: firstOf(y, qStart - 3), end: lastDayOf(y, qStart - 1) }
    }
    case 'last-year':
      return { start: toISODate(new Date(y - 1, 0, 1)), end: toISODate(new Date(y - 1, 11, 31)) }
    case 'last-3':
      return { start: firstOf(y, m - 2), end: toISODate(now) }
    case 'last-6':
      return { start: firstOf(y, m - 5), end: toISODate(now) }
    case 'last-12':
      return { start: firstOf(y, m - 11), end: toISODate(now) }
    case 'ytd':
      return { start: toISODate(new Date(y, 0, 1)), end: toISODate(now) }
    case 'custom':
      return { start: customStart, end: customEnd }
  }
}

const GROUP_BYS: { value: GroupBy; label: string }[] = [
  { value: 'category', label: 'Category' },
  { value: 'merchant', label: 'Merchant' },
  { value: 'account', label: 'Account' },
  { value: 'tag', label: 'Tag' },
]

const GROUP_BY_PLURAL: Record<GroupBy, string> = {
  category: 'categories',
  merchant: 'merchants',
  account: 'accounts',
  tag: 'tags',
}

// ─── shared filter state ─────────────────────────────────────────────────────

interface FilterState {
  preset: Preset
  setPreset: (p: Preset) => void
  customStart: string
  setCustomStart: (s: string) => void
  customEnd: string
  setCustomEnd: (s: string) => void
  groupBy: GroupBy
  setGroupBy: (g: GroupBy) => void
  selectedAccountIds: UUID[] | null
  toggleAccount: (id: UUID) => void
  setSelectedAccountIds: (ids: UUID[] | null) => void
  selectedCategoryIds: UUID[] | null
  toggleCategory: (id: UUID) => void
  setSelectedCategoryIds: (ids: UUID[] | null) => void
  excludeTransfers: boolean
  setExcludeTransfers: (b: boolean) => void
  excludeIgnored: boolean
  setExcludeIgnored: (b: boolean) => void
}

function useReportFilters(): FilterState {
  const [preset, setPreset] = useState<Preset>('last-12')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('category')
  const [selectedAccountIds, setSelectedAccountIds] = useState<UUID[] | null>(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<UUID[] | null>(null)
  const [excludeTransfers, setExcludeTransfers] = useState(true)
  const [excludeIgnored, setExcludeIgnored] = useState(true)

  const toggleAccount = (id: UUID) =>
    setSelectedAccountIds((prev) => {
      const list = prev ?? []
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
    })
  const toggleCategory = (id: UUID) =>
    setSelectedCategoryIds((prev) => {
      const list = prev ?? []
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
    })

  return {
    preset,
    setPreset,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    groupBy,
    setGroupBy,
    selectedAccountIds,
    toggleAccount,
    setSelectedAccountIds,
    selectedCategoryIds,
    toggleCategory,
    setSelectedCategoryIds,
    excludeTransfers,
    setExcludeTransfers,
    excludeIgnored,
    setExcludeIgnored,
  }
}

/** Apply a FilterState's excludes + account/category selections to a raw set. */
function applyFilters(f: FilterState, allTxns: Transaction[]): Transaction[] {
  let txns = applyExcludes(allTxns, {
    excludeTransfers: f.excludeTransfers,
    excludeIgnored: f.excludeIgnored,
  })
  if (f.selectedAccountIds) {
    const set = new Set(f.selectedAccountIds)
    txns = txns.filter((t) => set.has(t.account_id))
  }
  if (f.selectedCategoryIds) {
    const set = new Set(f.selectedCategoryIds)
    txns = txns.filter((t) => t.category_id != null && set.has(t.category_id))
  }
  return txns
}

/** Fetch + filter transactions for the current range and filter selections. */
function useFilteredTransactions(f: FilterState) {
  const now = useMemo(() => new Date(), [])
  const range = useMemo(
    () => rangeFor(f.preset, now, f.customStart, f.customEnd),
    [f.preset, f.customStart, f.customEnd, now],
  )
  const { data: allTxns = [], isLoading } = useTransactionsRange(range.start, range.end)

  const filtered = useMemo(
    () => applyFilters(f, allTxns),
    [allTxns, f.excludeTransfers, f.excludeIgnored, f.selectedAccountIds, f.selectedCategoryIds], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return { range, filtered, isLoading }
}

/** The period immediately before [start, end], of the same length (for the
 *  Compare view). Computed on calendar days, inclusive on both ends. */
function priorRange(range: Range): Range {
  const start = new Date(`${range.start}T00:00:00`)
  const end = new Date(`${range.end}T00:00:00`)
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  const priorEnd = new Date(start)
  priorEnd.setDate(priorEnd.getDate() - 1)
  const priorStart = new Date(priorEnd)
  priorStart.setDate(priorStart.getDate() - (days - 1))
  return { start: toISODate(priorStart), end: toISODate(priorEnd) }
}

// ─── filter controls ─────────────────────────────────────────────────────────

function FilterBar({ f }: { f: FilterState }) {
  const { data: accounts = [] } = useAccountsWithBalance()
  const { data: categories = [] } = useCategories()

  const accountFilterLabel =
    f.selectedAccountIds == null
      ? 'All accounts'
      : f.selectedAccountIds.length === 0
        ? 'None'
        : `${f.selectedAccountIds.length} selected`
  const categoryFilterLabel =
    f.selectedCategoryIds == null
      ? 'All categories'
      : f.selectedCategoryIds.length === 0
        ? 'None'
        : `${f.selectedCategoryIds.length} selected`

  return (
    <div className="card-surface space-y-4 p-4 md:p-5">
      <div className="flex flex-wrap items-end gap-4">
        {/* Presets */}
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Range</span>
          <div className="inline-flex flex-wrap gap-1 rounded-lg border border-outline-variant/50 p-1">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => f.setPreset(p.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  f.preset === p.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {f.preset === 'custom' && (
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reports-start" className="eyebrow">
                From
              </Label>
              <Input
                id="reports-start"
                type="date"
                value={f.customStart}
                onChange={(e) => f.setCustomStart(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reports-end" className="eyebrow">
                To
              </Label>
              <Input
                id="reports-end"
                type="date"
                value={f.customEnd}
                onChange={(e) => f.setCustomEnd(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Group by */}
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Group by</span>
          <div className="inline-flex gap-1 rounded-lg border border-outline-variant/50 p-1">
            {GROUP_BYS.map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => f.setGroupBy(g.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  f.groupBy === g.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {/* Account multi-select */}
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Accounts</span>
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-muted">
              {accountFilterLabel}
            </summary>
            <div className="absolute z-20 mt-1 max-h-64 w-64 overflow-auto rounded-md border bg-popover p-2 shadow-lg">
              <div className="mb-1 flex gap-2 px-2">
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => f.setSelectedAccountIds(null)}
                >
                  All
                </button>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => f.setSelectedAccountIds([])}
                >
                  None
                </button>
              </div>
              {accounts.map((a) => {
                const checked = f.selectedAccountIds == null || f.selectedAccountIds.includes(a.id)
                return (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => f.toggleAccount(a.id)} />
                    <span className="truncate">{a.name}</span>
                  </label>
                )
              })}
            </div>
          </details>
        </div>

        {/* Category multi-select */}
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Categories</span>
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-muted">
              {categoryFilterLabel}
            </summary>
            <div className="absolute z-20 mt-1 max-h-64 w-64 overflow-auto rounded-md border bg-popover p-2 shadow-lg">
              <div className="mb-1 flex gap-2 px-2">
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => f.setSelectedCategoryIds(null)}
                >
                  All
                </button>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => f.setSelectedCategoryIds([])}
                >
                  None
                </button>
              </div>
              {categories.map((c) => {
                const checked =
                  f.selectedCategoryIds == null || f.selectedCategoryIds.includes(c.id)
                return (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => f.toggleCategory(c.id)} />
                    <span className="truncate">{c.name}</span>
                  </label>
                )
              })}
            </div>
          </details>
        </div>

        {/* Exclusions */}
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={f.excludeTransfers} onCheckedChange={f.setExcludeTransfers} />
          Exclude transfers
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={f.excludeIgnored} onCheckedChange={f.setExcludeIgnored} />
          Exclude ignored
        </label>
      </div>
    </div>
  )
}

// ─── spending report ─────────────────────────────────────────────────────────

const DONUT_N = 10

/** Fallback series palette for non-category groupings (merchant/account/tag),
 *  which carry no stored color of their own. Category groups always use the
 *  category's own stored color. */
const GROUP_PALETTE = [
  '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4',
  '#f97316', '#84cc16', '#6366f1', '#eab308', '#14b8a6', '#a855f7',
]

function groupColorOf(g: ReportGroup, i: number): string {
  return g.color ?? GROUP_PALETTE[i % GROUP_PALETTE.length]
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function FlowReport({ f, flow }: { f: FilterState; flow: ReportFlow }) {
  const { range, filtered, isLoading } = useFilteredTransactions(f)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const [drill, setDrill] = useState<ReportGroup | null>(null)
  const drillScrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(drillScrollRef)

  // Compare to the immediately-prior period of the same length (Simplifi's
  // Compare). Same filters applied to the prior fetch.
  const [compare, setCompare] = useState(false)
  const prior = useMemo(() => priorRange(range), [range])
  const { data: priorTxns = [] } = useTransactionsRange(prior.start, prior.end, {
    enabled: compare,
  })
  const priorFiltered = useMemo(
    () => (compare ? applyFilters(f, priorTxns) : []),
    [compare, priorTxns, f.excludeTransfers, f.excludeIgnored, f.selectedAccountIds, f.selectedCategoryIds], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const priorByGroup = useMemo(() => {
    const map = new Map<string, number>()
    for (const g of groupFlow(priorFiltered, flow, f.groupBy, accountsById)) {
      map.set(g.id, g.total)
    }
    return map
  }, [priorFiltered, flow, f.groupBy, accountsById])
  const priorFlowTotal = useMemo(
    () => [...priorByGroup.values()].reduce((s, v) => s + v, 0),
    [priorByGroup],
  )

  const stats = useMemo(() => {
    let spend = 0
    let income = 0
    for (const t of filtered) {
      if (t.amount > 0) spend += t.amount
      else income += -t.amount
    }
    return { spend, income, count: filtered.length }
  }, [filtered])
  const flowTotal = flow === 'spend' ? stats.spend : stats.income
  const flowLabel = flow === 'spend' ? 'expenses' : 'income'

  const groups = useMemo(
    () => groupFlow(filtered, flow, f.groupBy, accountsById),
    [filtered, flow, f.groupBy, accountsById],
  )
  const topGroups = useMemo(() => topNWithOther(groups, DONUT_N), [groups])
  const maxGroup = topGroups[0]?.total ?? 0

  const drillTxns = useMemo<Transaction[]>(() => {
    if (!drill || drill.id === '__other__') return []
    const list = filtered.filter(
      (t) => groupKeyFor(t, f.groupBy, accountsById).id === drill.id,
    )
    return [...list].sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount)
  }, [drill, filtered, f.groupBy, accountsById])

  function exportGroupsCsv() {
    const csv = rowsToCsv(
      ['Group', 'Amount'],
      groups.map((g) => [g.label, g.total.toFixed(2)]),
    )
    downloadCsv(`${flow}-${f.groupBy}-${toISODate(new Date())}.csv`, csv)
  }

  function exportDrillCsv() {
    if (!drill) return
    const csv = rowsToCsv(
      ['Date', 'Payee', 'Category', 'Account', 'Amount'],
      drillTxns.map((t) => [
        t.date,
        displayName(t),
        t.categories?.name ?? 'Uncategorized',
        accountsById.get(t.account_id)?.name ?? '',
        t.amount.toFixed(2),
      ]),
    )
    downloadCsv(`${flow}-${drill.label.replace(/\s+/g, '-').toLowerCase()}.csv`, csv)
  }

  const groupColor = groupColorOf

  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} />

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          {/* Compare + print toolbar */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={compare} onCheckedChange={setCompare} />
              Compare to prior period
            </label>
            {compare && (
              <span className="text-sm text-muted-foreground">
                {flow === 'spend' ? 'Expenses' : 'Income'} {formatCurrency(flowTotal)} vs{' '}
                {formatCurrency(priorFlowTotal)} prior (
                {priorFlowTotal > 0
                  ? `${flowTotal >= priorFlowTotal ? '+' : ''}${(((flowTotal - priorFlowTotal) / priorFlowTotal) * 100).toFixed(1)}%`
                  : '—'}
                )
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => window.print()}
            >
              Print / PDF
            </Button>
          </div>

          {/* Summary strip */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="card-surface p-4">
              <p className="eyebrow">Total spend</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-money-expense">
                {formatCurrency(stats.spend)}
              </p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Total income</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-money-income">
                {formatCurrency(stats.income)}
              </p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Transactions</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{stats.count}</p>
            </div>
          </section>

          {/* Donut + legend */}
          <section className="card-surface p-4 md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="eyebrow">
                {flow === 'spend' ? 'Spending' : 'Income'} by {f.groupBy}
              </h2>
              <Button variant="ghost" size="sm" onClick={exportGroupsCsv}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                CSV
              </Button>
            </div>
            {topGroups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No {flowLabel} in this range.
              </p>
            ) : (
              <div className="grid gap-6 md:grid-cols-2">
                <div className="relative">
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={topGroups}
                        dataKey="total"
                        nameKey="label"
                        innerRadius={70}
                        outerRadius={110}
                        paddingAngle={1.5}
                        strokeWidth={0}
                        onClick={(_: unknown, index: number) => {
                          const g = topGroups[index]
                          if (g && g.id !== '__other__') setDrill(g)
                        }}
                        className="cursor-pointer"
                      >
                        {topGroups.map((g, i) => (
                          <Cell key={g.id} fill={groupColor(g, i)} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={chartTooltipStyle}
                        itemStyle={chartTooltipItemStyle}
                        labelStyle={chartTooltipLabelStyle}
                        formatter={(value: number, name: string) => [formatCurrency(value), name]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="eyebrow">Total</span>
                    <span className="text-xl font-bold tabular-nums">
                      {formatCurrency(flowTotal)}
                    </span>
                  </div>
                </div>
                <ul className="flex flex-col justify-center gap-1">
                  {topGroups.map((g, i) => (
                    <li key={g.id}>
                      <button
                        type="button"
                        disabled={g.id === '__other__'}
                        onClick={() => setDrill(g)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm',
                          g.id !== '__other__' && 'hover:bg-muted',
                        )}
                      >
                        <span
                          className="h-3 w-3 shrink-0 rounded-sm"
                          style={{ backgroundColor: groupColor(g, i) }}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{g.label}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {formatCurrency(g.total)}
                          {compare && priorByGroup.get(g.id) != null && (
                            <span className="ml-2 text-xs">
                              vs {formatCurrency(priorByGroup.get(g.id) ?? 0)}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Horizontal bars */}
          {topGroups.length > 0 && (
            <section className="card-surface p-4 md:p-6">
              <h2 className="eyebrow mb-4">
                Top {f.groupBy === 'category' ? 'categories' : GROUP_BY_PLURAL[f.groupBy]}
              </h2>
              <ul className="space-y-2.5">
                {topGroups.map((g, i) => (
                  <li key={g.id} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 truncate text-sm text-foreground">{g.label}</span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full rounded"
                        style={{
                          width: `${maxGroup > 0 ? (g.total / maxGroup) * 100 : 0}%`,
                          backgroundColor: groupColor(g, i),
                        }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                      {formatCurrency(g.total)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Drill-down */}
          {drill && (
            <section className="card-surface p-4 md:p-6">
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setDrill(null)}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
                    All {GROUP_BY_PLURAL[f.groupBy]}
                  </Button>
                  <h2 className="truncate text-sm font-semibold text-foreground">{drill.label}</h2>
                </div>
                <Button variant="ghost" size="sm" onClick={exportDrillCsv}>
                  <Download className="mr-1.5 h-4 w-4" aria-hidden />
                  CSV
                </Button>
              </div>
              <div className="mb-3 flex gap-6 text-sm">
                <span className="text-muted-foreground">
                  Total{' '}
                  <strong className="tabular-nums text-foreground">
                    {formatCurrency(drill.total)}
                  </strong>
                </span>
                <span className="text-muted-foreground">
                  Transactions{' '}
                  <strong className="tabular-nums text-foreground">{drillTxns.length}</strong>
                </span>
              </div>
              <div ref={drillScrollRef} className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Payee</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drillTxns.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {shortDate(t.date)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-medium">
                          {displayName(t)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {t.categories?.name ?? 'Uncategorized'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {accountsById.get(t.account_id)?.name ?? ''}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'whitespace-nowrap text-right tabular-nums',
                            t.amount < 0 ? 'text-money-income' : 'text-foreground',
                          )}
                        >
                          {t.amount < 0 ? '+' : ''}
                          {formatCurrency(t.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

// ─── spending summary report ──────────────────────────────────────────────────

const SUMMARY_N = 8

function FlowSummaryReport({ f, flow }: { f: FilterState; flow: ReportFlow }) {
  const { range, filtered, isLoading } = useFilteredTransactions(f)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const tableScrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(tableScrollRef)

  const { groups, monthCols } = useMemo(() => {
    const groups = topNWithOther(groupFlow(filtered, flow, f.groupBy, accountsById), SUMMARY_N)
    const hasOther = groups.some((g) => g.id === '__other__')
    const buckets = monthlyBuckets(filtered, range.start, range.end)
    const monthCols = buckets.map((b) => {
      const bucketTotal = flow === 'spend' ? b.spend : b.income
      const perKey = new Map<string, number>()
      for (const t of filtered) {
        if (t.date.slice(0, 7) !== b.monthKey) continue
        if (flow === 'spend' ? t.amount <= 0 : t.amount >= 0) continue
        const k = groupKeyFor(t, f.groupBy, accountsById).id
        perKey.set(k, (perKey.get(k) ?? 0) + Math.abs(t.amount))
      }
      let topSum = 0
      const cells = groups.map((g) => {
        if (g.id === '__other__') return 0
        const v = perKey.get(g.id) ?? 0
        topSum += v
        return v
      })
      if (hasOther) cells[cells.length - 1] = Math.max(0, bucketTotal - topSum)
      return { label: b.label, cells, total: bucketTotal }
    })
    return { groups, monthCols }
  }, [filtered, flow, f.groupBy, accountsById, range.start, range.end])

  const chartData = useMemo(
    () =>
      monthCols.map((c) => {
        const row: Record<string, string | number> = { month: c.label }
        groups.forEach((g, i) => {
          row[g.id] = c.cells[i] ?? 0
        })
        return row
      }),
    [monthCols, groups],
  )

  const groupColor = groupColorOf

  function exportSummaryCsv() {
    const csv = rowsToCsv(
      ['Group', ...monthCols.map((c) => c.label), 'Total'],
      groups.map((g, i) => [
        g.label,
        ...monthCols.map((c) => (c.cells[i] ?? 0).toFixed(2)),
        g.total.toFixed(2),
      ]),
    )
    downloadCsv(`${flow}-summary-${f.groupBy}-${toISODate(new Date())}.csv`, csv)
  }

  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} />

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          <section className="card-surface p-4 md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="eyebrow">
                Monthly {flow === 'spend' ? 'spending' : 'income'} by {f.groupBy}
              </h2>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => window.print()}>
                  Print / PDF
                </Button>
                <Button variant="ghost" size="sm" onClick={exportSummaryCsv}>
                  <Download className="mr-1.5 h-4 w-4" aria-hidden />
                  CSV
                </Button>
              </div>
            </div>
            {monthCols.length === 0 || groups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No {flow === 'spend' ? 'spending' : 'income'} in this range.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="month"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={72}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v: number) => formatCurrency(v)}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    itemStyle={chartTooltipItemStyle}
                    labelStyle={chartTooltipLabelStyle}
                    formatter={(value: number, name: string) => [
                      formatCurrency(value),
                      groups.find((g) => g.id === name)?.label ?? name,
                    ]}
                  />
                  {groups.map((g, i) => (
                    <Bar key={g.id} dataKey={g.id} stackId="spend" fill={groupColor(g, i)} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </section>

          {groups.length > 0 && monthCols.length > 0 && (
            <section className="card-surface p-4 md:p-6">
              <h2 className="eyebrow mb-4">
                {f.groupBy === 'category' ? 'Category' : GROUP_BY_PLURAL[f.groupBy]} by month
              </h2>
              <div ref={tableScrollRef} className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {f.groupBy === 'category'
                          ? 'Category'
                          : f.groupBy === 'merchant'
                            ? 'Merchant'
                            : f.groupBy === 'tag'
                              ? 'Tag'
                              : 'Account'}
                      </TableHead>
                      {monthCols.map((c) => (
                        <TableHead key={c.label} className="whitespace-nowrap text-right">
                          {c.label}
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((g, i) => (
                      <TableRow key={g.id}>
                        <TableCell className="whitespace-nowrap font-medium">
                          <span className="mr-2 inline-flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-sm"
                              style={{ backgroundColor: groupColor(g, i) }}
                              aria-hidden
                            />
                            {g.label}
                          </span>
                        </TableCell>
                        {monthCols.map((c) => {
                          const v = c.cells[i] ?? 0
                          return (
                            <TableCell
                              key={c.label}
                              className="whitespace-nowrap text-right tabular-nums text-muted-foreground"
                            >
                              {v === 0 ? '—' : formatCurrency(v)}
                            </TableCell>
                          )
                        })}
                        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                          {formatCurrency(g.total)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell className="font-semibold">Total</TableCell>
                      {monthCols.map((c) => (
                        <TableCell
                          key={c.label}
                          className="whitespace-nowrap text-right font-semibold tabular-nums"
                        >
                          {formatCurrency(c.total)}
                        </TableCell>
                      ))}
                      <TableCell className="whitespace-nowrap text-right font-bold tabular-nums">
                        {formatCurrency(monthCols.reduce((s, c) => s + c.total, 0))}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

// ─── income & expense report ──────────────────────────────────────────────────

function IncomeExpenseReport({ f }: { f: FilterState }) {
  const { range, filtered, isLoading } = useFilteredTransactions(f)
  const buckets = useMemo(
    () => monthlyBuckets(filtered, range.start, range.end),
    [filtered, range.start, range.end],
  )
  const totals = useMemo(
    () => ({
      income: buckets.reduce((s, b) => s + b.income, 0),
      spend: buckets.reduce((s, b) => s + b.spend, 0),
    }),
    [buckets],
  )
  const tableScrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(tableScrollRef)

  function exportCsv() {
    const csv = rowsToCsv(
      ['Month', 'Income', 'Expenses', 'Net'],
      buckets.map((b) => [
        b.label,
        b.income.toFixed(2),
        b.spend.toFixed(2),
        (b.income - b.spend).toFixed(2),
      ]),
    )
    downloadCsv(`income-expense-${toISODate(new Date())}.csv`, csv)
  }

  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} />
      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="card-surface p-4">
              <p className="eyebrow">Total income</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-money-income">
                {formatCurrency(totals.income)}
              </p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Total expenses</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-money-expense">
                {formatCurrency(totals.spend)}
              </p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Net</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {formatCurrency(totals.income - totals.spend)}
              </p>
            </div>
          </section>

          <section className="card-surface p-4 md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="eyebrow">Income vs expenses by month</h2>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => window.print()}>
                  Print / PDF
                </Button>
                <Button variant="ghost" size="sm" onClick={exportCsv}>
                  <Download className="mr-1.5 h-4 w-4" aria-hidden />
                  CSV
                </Button>
              </div>
            </div>
            {buckets.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing in this range.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={buckets} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={72}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v: number) => formatCurrency(v)}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    itemStyle={chartTooltipItemStyle}
                    labelStyle={chartTooltipLabelStyle}
                    formatter={(value: number, name: string) => [formatCurrency(value), name]}
                  />
                  <Bar dataKey="income" name="Income" fill="#10b981" />
                  <Bar dataKey="spend" name="Expenses" fill="#f59e0b" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </section>

          {buckets.length > 0 && (
            <section className="card-surface p-4 md:p-6">
              <div ref={tableScrollRef} className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Income</TableHead>
                      <TableHead className="text-right">Expenses</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {buckets.map((b) => (
                      <TableRow key={b.monthKey}>
                        <TableCell className="whitespace-nowrap font-medium">{b.label}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums text-money-income">
                          {formatCurrency(b.income)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums text-money-expense">
                          {formatCurrency(b.spend)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                          {formatCurrency(b.income - b.spend)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

// ─── monthly summary report ───────────────────────────────────────────────────

function MonthlySummaryReport() {
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const start = toISODate(month)
  const end = toISODate(new Date(month.getFullYear(), month.getMonth() + 1, 0))
  const { data: allTxns = [], isLoading } = useTransactionsRange(start, end)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const txns = useMemo(
    () => applyExcludes(allTxns, { excludeTransfers: true, excludeIgnored: true }),
    [allTxns],
  )
  const stats = useMemo(() => {
    let spend = 0
    let income = 0
    for (const t of txns) {
      if (t.amount > 0) spend += t.amount
      else income += -t.amount
    }
    return { spend, income }
  }, [txns])
  const topSpend = useMemo(
    () => groupSpend(txns, 'category', accountsById).slice(0, 5),
    [txns, accountsById],
  )
  const topIncome = useMemo(
    () => groupFlow(txns, 'income', 'merchant', accountsById).slice(0, 5),
    [txns, accountsById],
  )
  const largest = useMemo(
    () => [...txns].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5),
    [txns],
  )
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          ← Prev
        </Button>
        <h2 className="text-lg font-semibold text-foreground">{monthLabel}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          Next →
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => window.print()}>
          Print / PDF
        </Button>
      </div>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="card-surface p-4">
              <p className="eyebrow">Income</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-money-income">
                {formatCurrency(stats.income)}
              </p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Spending</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-money-expense">
                {formatCurrency(stats.spend)}
              </p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Net saved</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {formatCurrency(stats.income - stats.spend)}
              </p>
            </div>
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="card-surface p-4 md:p-6">
              <h3 className="eyebrow mb-4">Top spending categories</h3>
              {topSpend.length === 0 ? (
                <p className="text-sm text-muted-foreground">No spending this month.</p>
              ) : (
                <ul className="space-y-2.5">
                  {topSpend.map((g) => (
                    <li key={g.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-foreground">{g.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatCurrency(g.total)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card-surface p-4 md:p-6">
              <h3 className="eyebrow mb-4">Top income sources</h3>
              {topIncome.length === 0 ? (
                <p className="text-sm text-muted-foreground">No income this month.</p>
              ) : (
                <ul className="space-y-2.5">
                  {topIncome.map((g) => (
                    <li key={g.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-foreground">{g.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatCurrency(g.total)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="card-surface p-4 md:p-6">
            <h3 className="eyebrow mb-4">Largest transactions</h3>
            {largest.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transactions this month.</p>
            ) : (
              <ul className="divide-y divide-border">
                {largest.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="w-16 shrink-0 text-muted-foreground">
                      {shortDate(t.date)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {displayName(t)}
                    </span>
                    <span className="hidden shrink-0 text-muted-foreground sm:inline">
                      {t.categories?.name ?? 'Uncategorized'}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 tabular-nums',
                        t.amount < 0 ? 'text-money-income' : 'text-foreground',
                      )}
                    >
                      {t.amount < 0 ? '+' : ''}
                      {formatCurrency(t.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

// ─── saved reports (localStorage) ─────────────────────────────────────────────

interface SavedReport {
  id: string
  name: string
  report: ReportId
  preset: Preset
  groupBy: GroupBy
  excludeTransfers: boolean
  excludeIgnored: boolean
}

const SAVED_REPORTS_KEY = 'pocketlens.savedReports'

function loadSavedReports(): SavedReport[] {
  try {
    const raw = localStorage.getItem(SAVED_REPORTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedReport[]
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.id && r.name && r.report) : []
  } catch {
    return []
  }
}

function storeSavedReports(reports: SavedReport[]) {
  try {
    localStorage.setItem(SAVED_REPORTS_KEY, JSON.stringify(reports))
  } catch {
    // Storage full/blocked — saved reports are a convenience, never fatal.
  }
}

// ─── report picker home ───────────────────────────────────────────────────────

const REPORT_CARDS: { id: ReportId; title: string; hint: string; blurb: string }[] = [
  {
    id: 'spending',
    title: 'Spending',
    hint: 'See where your money goes',
    blurb:
      'Donut, top groups, and transaction drill-down by category, merchant, account, or tag — with prior-period compare.',
  },
  {
    id: 'summary',
    title: 'Spending Summary',
    hint: 'View your spending over time',
    blurb: 'Stacked monthly chart and a group-by-month table.',
  },
  {
    id: 'income',
    title: 'Income',
    hint: 'Track your sources of income',
    blurb: 'Income grouped by category, merchant, account, or tag, with drill-down.',
  },
  {
    id: 'income-summary',
    title: 'Income Summary',
    hint: 'View your income over time',
    blurb: 'Stacked monthly income chart and a group-by-month table.',
  },
  {
    id: 'income-expense',
    title: 'Income & Expense',
    hint: 'Compare income and expenses',
    blurb: 'Monthly income vs expenses with a net column, month by month.',
  },
  {
    id: 'monthly-summary',
    title: 'Monthly Summary',
    hint: 'A snapshot of one month',
    blurb: 'Income, spending, net, top categories and sources, and largest transactions for a month.',
  },
  {
    id: 'forecast',
    title: 'Forecast',
    hint: 'Live from your spending plan',
    blurb:
      'Where you are headed — projected net worth from the live plan baseline plus your adjustments.',
  },
]

function ReportsHome({
  onSelect,
  saved,
  onOpenSaved,
  onDeleteSaved,
}: {
  onSelect: (id: ReportId) => void
  saved: SavedReport[]
  onOpenSaved: (r: SavedReport) => void
  onDeleteSaved: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const cards = REPORT_CARDS.filter((r) =>
    r.title.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Pick a report to open it. Reports default to the trailing 12 months.
        </p>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search reports"
          aria-label="Search reports"
          className="ml-auto w-56"
        />
      </div>

      {saved.length > 0 && (
        <section className="mb-8">
          <h2 className="eyebrow mb-3">Saved reports</h2>
          <ul className="divide-y divide-border card-surface px-4">
            {saved.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3">
                <button
                  type="button"
                  onClick={() => onOpenSaved(r)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-foreground hover:underline">
                    {r.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {REPORT_TITLES[r.report]} · {PRESETS.find((p) => p.value === r.preset)?.label ?? r.preset}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDeleteSaved(r.id)}
                  aria-label={`Delete saved report ${r.name}`}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((r) => (
          <button key={r.id} type="button" onClick={() => onSelect(r.id)} className="report-card">
            <h3 className="text-base font-semibold text-foreground">{r.title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{r.hint}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.blurb}</p>
          </button>
        ))}
        {cards.length === 0 && (
          <p className="text-sm text-muted-foreground">No reports match “{query}”.</p>
        )}
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

const REPORT_TITLES: Record<ReportId, string> = {
  spending: 'Spending',
  summary: 'Spending Summary',
  income: 'Income',
  'income-summary': 'Income Summary',
  'income-expense': 'Income & Expense',
  'monthly-summary': 'Monthly Summary',
  forecast: 'Forecast',
}

/** Reports that honor the shared FilterState (all but Monthly Summary, which
 *  has its own month picker, and Forecast). */
const FILTERED_REPORTS: ReportId[] = [
  'spending',
  'summary',
  'income',
  'income-summary',
  'income-expense',
]

export default function ReportsPage() {
  const [active, setActive] = useState<ReportId | null>(null)
  // One shared filter state so switching reports keeps the chosen view.
  const filters = useReportFilters()
  const [saved, setSaved] = useState<SavedReport[]>(() => loadSavedReports())

  function openSaved(r: SavedReport) {
    filters.setPreset(r.preset)
    filters.setGroupBy(r.groupBy)
    filters.setExcludeTransfers(r.excludeTransfers)
    filters.setExcludeIgnored(r.excludeIgnored)
    setActive(r.report)
  }

  function deleteSaved(id: string) {
    setSaved((prev) => {
      const next = prev.filter((r) => r.id !== id)
      storeSavedReports(next)
      return next
    })
  }

  function saveCurrent() {
    if (!active) return
    const name = window.prompt('Name this report:', REPORT_TITLES[active])
    if (!name || !name.trim()) return
    const entry: SavedReport = {
      id: `sr-${Date.now().toString(36)}`,
      name: name.trim(),
      report: active,
      preset: filters.preset,
      groupBy: filters.groupBy,
      excludeTransfers: filters.excludeTransfers,
      excludeIgnored: filters.excludeIgnored,
    }
    setSaved((prev) => {
      const next = [...prev, entry]
      storeSavedReports(next)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div className="flex items-center gap-3">
        {active && (
          <Button variant="ghost" size="sm" onClick={() => setActive(null)}>
            <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
            Reports
          </Button>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {active ? REPORT_TITLES[active] : 'Reports'}
        </h1>
        {active && FILTERED_REPORTS.includes(active) && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={saveCurrent}>
            Save report
          </Button>
        )}
      </div>

      {active === null && (
        <ReportsHome
          onSelect={setActive}
          saved={saved}
          onOpenSaved={openSaved}
          onDeleteSaved={deleteSaved}
        />
      )}
      {active === 'spending' && <FlowReport f={filters} flow="spend" />}
      {active === 'summary' && <FlowSummaryReport f={filters} flow="spend" />}
      {active === 'income' && <FlowReport f={filters} flow="income" />}
      {active === 'income-summary' && <FlowSummaryReport f={filters} flow="income" />}
      {active === 'income-expense' && <IncomeExpenseReport f={filters} />}
      {active === 'monthly-summary' && <MonthlySummaryReport />}
      {active === 'forecast' && <ForecastSection />}
    </div>
  )
}
