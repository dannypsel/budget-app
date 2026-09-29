// Reports — Simplifi-style report picker with three reports:
//   Spending (donut + bars + grouped detail with transaction drill-down),
//   Spending Summary (stacked monthly chart + group×month table),
//   Forecast (live spending-plan baseline projection, selectable like any report).
// Trailing 12 months is the default range. Sign convention: amount > 0 =
// spend, amount < 0 = income. Grouped breakdowns are spend-only; transfer and
// ignored exclusions are applied client-side so toggling is instant.

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
  groupSpend,
  monthlyBuckets,
  topNWithOther,
  type GroupBy,
  type ReportGroup,
} from '@/lib/reports'
import { formatCurrency } from '@/lib/money'
import { toISODate } from '@/lib/dates'
import { categorySeriesColor } from '@/lib/categoryColors'
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

type ReportId = 'spending' | 'summary' | 'forecast'

// ─── date presets ─────────────────────────────────────────────────────────────

type Preset = 'this-month' | 'last-month' | 'last-3' | 'last-6' | 'last-12' | 'ytd' | 'custom'

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-3', label: 'Last 3 months' },
  { value: 'last-6', label: 'Last 6 months' },
  { value: 'last-12', label: 'Last 12 months' },
  { value: 'ytd', label: 'Year to date' },
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
]

const GROUP_BY_PLURAL: Record<GroupBy, string> = {
  category: 'categories',
  merchant: 'merchants',
  account: 'accounts',
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

/** Fetch + filter transactions for the current range and filter selections. */
function useFilteredTransactions(f: FilterState) {
  const now = useMemo(() => new Date(), [])
  const range = useMemo(
    () => rangeFor(f.preset, now, f.customStart, f.customEnd),
    [f.preset, f.customStart, f.customEnd, now],
  )
  const { data: allTxns = [], isLoading } = useTransactionsRange(range.start, range.end)

  const filtered = useMemo(() => {
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
  }, [allTxns, f.excludeTransfers, f.excludeIgnored, f.selectedAccountIds, f.selectedCategoryIds])

  return { range, filtered, isLoading }
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

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function SpendingReport({ f }: { f: FilterState }) {
  const { filtered, isLoading } = useFilteredTransactions(f)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const [drill, setDrill] = useState<ReportGroup | null>(null)
  const drillScrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(drillScrollRef)

  const stats = useMemo(() => {
    let spend = 0
    let income = 0
    for (const t of filtered) {
      if (t.amount > 0) spend += t.amount
      else income += -t.amount
    }
    return { spend, income, count: filtered.length }
  }, [filtered])

  const groups = useMemo(
    () => groupSpend(filtered, f.groupBy, accountsById),
    [filtered, f.groupBy, accountsById],
  )
  const topGroups = useMemo(() => topNWithOther(groups, DONUT_N), [groups])
  const maxGroup = topGroups[0]?.total ?? 0

  const drillTxns = useMemo<Transaction[]>(() => {
    if (!drill || drill.id === '__other__') return []
    const list = filtered.filter((t) => {
      if (f.groupBy === 'category') return (t.category_id ?? '__uncategorized__') === drill.id
      if (f.groupBy === 'merchant') return displayName(t) === drill.id
      return t.account_id === drill.id
    })
    return [...list].sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount)
  }, [drill, filtered, f.groupBy])

  function exportGroupsCsv() {
    const csv = rowsToCsv(
      ['Group', 'Amount'],
      groups.map((g) => [g.label, g.total.toFixed(2)]),
    )
    downloadCsv(`spending-${f.groupBy}-${toISODate(new Date())}.csv`, csv)
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
    downloadCsv(`spending-${drill.label.replace(/\s+/g, '-').toLowerCase()}.csv`, csv)
  }

  const groupColor = (g: ReportGroup, i: number) => g.color ?? categorySeriesColor(i)

  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} />

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          {/* Summary strip */}
          <section className="grid grid-cols-3 gap-4">
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
              <h2 className="eyebrow">Spending by {f.groupBy}</h2>
              <Button variant="ghost" size="sm" onClick={exportGroupsCsv}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                CSV
              </Button>
            </div>
            {topGroups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No spending in this range.
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
                      {formatCurrency(stats.spend)}
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

function SpendingSummaryReport({ f }: { f: FilterState }) {
  const { range, filtered, isLoading } = useFilteredTransactions(f)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const tableScrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(tableScrollRef)

  const { groups, monthCols } = useMemo(() => {
    const groups = topNWithOther(groupSpend(filtered, f.groupBy, accountsById), SUMMARY_N)
    const topIds = new Set(groups.filter((g) => g.id !== '__other__').map((g) => g.id))
    const hasOther = groups.some((g) => g.id === '__other__')
    const buckets = monthlyBuckets(filtered, range.start, range.end)
    const monthCols = buckets.map((b) => {
      const perKey = new Map<string, number>()
      for (const t of filtered) {
        if (t.date.slice(0, 7) !== b.monthKey || t.amount <= 0) continue
        const k =
          f.groupBy === 'category'
            ? (t.category_id ?? '__uncategorized__')
            : f.groupBy === 'merchant'
              ? displayName(t)
              : t.account_id
        perKey.set(k, (perKey.get(k) ?? 0) + t.amount)
      }
      let topSum = 0
      const cells = groups.map((g) => {
        if (g.id === '__other__') return 0
        const v = perKey.get(g.id) ?? 0
        topSum += v
        return v
      })
      if (hasOther) cells[cells.length - 1] = Math.max(0, b.spend - topSum)
      return { label: b.label, cells, total: b.spend }
    })
    return { groups, monthCols }
  }, [filtered, f.groupBy, accountsById, range.start, range.end])

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

  const groupColor = (g: ReportGroup, i: number) => g.color ?? categorySeriesColor(i)

  function exportSummaryCsv() {
    const csv = rowsToCsv(
      ['Group', ...monthCols.map((c) => c.label), 'Total'],
      groups.map((g, i) => [
        g.label,
        ...monthCols.map((c) => (c.cells[i] ?? 0).toFixed(2)),
        g.total.toFixed(2),
      ]),
    )
    downloadCsv(`spending-summary-${f.groupBy}-${toISODate(new Date())}.csv`, csv)
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
              <h2 className="eyebrow">Monthly spending by {f.groupBy}</h2>
              <Button variant="ghost" size="sm" onClick={exportSummaryCsv}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                CSV
              </Button>
            </div>
            {monthCols.length === 0 || groups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No spending in this range.
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

// ─── report picker home ───────────────────────────────────────────────────────

const REPORT_CARDS: { id: ReportId; title: string; hint: string; blurb: string }[] = [
  {
    id: 'spending',
    title: 'Spending',
    hint: 'Default: last 12 months',
    blurb:
      'Where your money goes — donut, top groups, and transaction drill-down by category, merchant, or account.',
  },
  {
    id: 'summary',
    title: 'Spending Summary',
    hint: 'Default: last 12 months',
    blurb: 'Spending over time — stacked monthly chart and a group-by-month table.',
  },
  {
    id: 'forecast',
    title: 'Forecast',
    hint: 'Live from your spending plan',
    blurb:
      'Where you are headed — projected net worth from the live plan baseline plus your adjustments.',
  },
]

function ReportsHome({ onSelect }: { onSelect: (id: ReportId) => void }) {
  return (
    <div>
      <p className="mb-6 text-sm text-muted-foreground">
        Pick a report to open it. Spending reports default to the trailing 12 months.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORT_CARDS.map((r) => (
          <button key={r.id} type="button" onClick={() => onSelect(r.id)} className="report-card">
            <h3 className="text-base font-semibold text-foreground">{r.title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{r.hint}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.blurb}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

const REPORT_TITLES: Record<ReportId, string> = {
  spending: 'Spending',
  summary: 'Spending Summary',
  forecast: 'Forecast',
}

export default function ReportsPage() {
  const [active, setActive] = useState<ReportId | null>(null)
  // One shared filter state per report so switching back preserves the view.
  const spendingFilters = useReportFilters()
  const summaryFilters = useReportFilters()

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
      </div>

      {active === null && <ReportsHome onSelect={setActive} />}
      {active === 'spending' && <SpendingReport f={spendingFilters} />}
      {active === 'summary' && <SpendingSummaryReport f={summaryFilters} />}
      {active === 'forecast' && <ForecastSection />}
    </div>
  )
}
