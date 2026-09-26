// Reports — barebones spend reporting: grouped breakdown (bar + donut), monthly
// income-vs-spend trend, and per-card spend (the churner's view). The page fetches
// with includeExcluded=true and applies the exclude toggles client-side so toggling
// is instant. Sign convention: Transaction.amount > 0 = spend, < 0 = income.

import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Download } from 'lucide-react'
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
import { useAccountsWithBalance, useCategories, useTransactionsRange } from '@/data/hooks'
import {
  applyExcludes,
  groupSpend,
  monthlyBuckets,
  perCardSpend,
  topNWithOther,
  type GroupBy,
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
import { cn } from '@/lib/utils'
import type { Account, Category, UUID } from '@/types/domain'

type Preset = 'this-month' | 'last-month' | 'last-3' | 'last-6' | 'last-12' | 'custom'

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-3', label: 'Last 3 months' },
  { value: 'last-6', label: 'Last 6 months' },
  { value: 'last-12', label: 'Last 12 months' },
  { value: 'custom', label: 'Custom' },
]

const GROUP_BYS: Array<{ value: GroupBy; label: string }> = [
  { value: 'category', label: 'Category' },
  { value: 'merchant', label: 'Merchant' },
  { value: 'account', label: 'Account' },
]

/** Series palette for merchant/account groupings (category grouping uses each
 *  category's own color via categorySeriesColor). */
const PALETTE = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4',
  '#f97316', '#6366f1', '#84cc16', '#eab308', '#14b8a6', '#a855f7',
]
const OTHER_COLOR = '#94a3b8'
const SPEND_LINE = '#e11d48'
const INCOME_LINE = '#16a34a'

const UNCATEGORIZED_KEY = '__uncategorized__'

function seriesColor(groupBy: GroupBy, index: number, color?: string): string {
  if (groupBy === 'category') return categorySeriesColor(color)
  return PALETTE[index % PALETTE.length]
}

export default function ReportsPage() {
  const today = useMemo(() => new Date(), [])
  const [preset, setPreset] = useState<Preset>('this-month')
  const [customStart, setCustomStart] = useState(() =>
    toISODate(new Date(today.getFullYear(), today.getMonth(), 1)),
  )
  const [customEnd, setCustomEnd] = useState(() => toISODate(today))
  const [groupBy, setGroupBy] = useState<GroupBy>('category')
  /** null = all accounts; otherwise an explicit selection. */
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[] | null>(null)
  /** null = all categories; otherwise explicit selection ('__uncategorized__' = none). */
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[] | null>(null)
  const [excludeTransfers, setExcludeTransfers] = useState(true)
  const [excludeIgnored, setExcludeIgnored] = useState(true)

  const range = useMemo(() => {
    switch (preset) {
      case 'this-month':
        return {
          start: toISODate(new Date(today.getFullYear(), today.getMonth(), 1)),
          end: toISODate(today),
        }
      case 'last-month': {
        const s = new Date(today.getFullYear(), today.getMonth() - 1, 1)
        const e = new Date(today.getFullYear(), today.getMonth(), 0)
        return { start: toISODate(s), end: toISODate(e) }
      }
      case 'last-3':
        return {
          start: toISODate(new Date(today.getFullYear(), today.getMonth() - 2, 1)),
          end: toISODate(today),
        }
      case 'last-6':
        return {
          start: toISODate(new Date(today.getFullYear(), today.getMonth() - 5, 1)),
          end: toISODate(today),
        }
      case 'last-12':
        return {
          start: toISODate(new Date(today.getFullYear(), today.getMonth() - 11, 1)),
          end: toISODate(today),
        }
      case 'custom':
        return { start: customStart, end: customEnd }
    }
  }, [preset, today, customStart, customEnd])

  const { data: allTxns = [], isLoading } = useTransactionsRange(range.start, range.end)
  const { data: accounts = [] } = useAccountsWithBalance()
  const { data: categories = [] } = useCategories()

  const accountsById = useMemo(() => new Map<UUID, Account>(accounts.map((a) => [a.id, a])), [accounts])
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.name.localeCompare(b.name)),
    [categories],
  )

  const toggleInSelection = (
    prev: string[] | null,
    allKeys: string[],
    key: string,
  ): string[] | null => {
    const cur = prev ?? allKeys
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
    return next.length === allKeys.length ? null : next
  }

  const toggleAccount = (id: string) =>
    setSelectedAccountIds((prev) =>
      toggleInSelection(prev, accounts.map((a) => a.id), id),
    )
  const toggleCategory = (key: string) =>
    setSelectedCategoryIds((prev) =>
      toggleInSelection(prev, [...categories.map((c) => c.id), UNCATEGORIZED_KEY], key),
    )

  const filtered = useMemo(() => {
    let txns = applyExcludes(allTxns, { excludeTransfers, excludeIgnored })
    if (selectedAccountIds) txns = txns.filter((t) => selectedAccountIds.includes(t.account_id))
    if (selectedCategoryIds) {
      txns = txns.filter((t) =>
        selectedCategoryIds.includes(t.category_id ?? UNCATEGORIZED_KEY),
      )
    }
    return txns
  }, [allTxns, excludeTransfers, excludeIgnored, selectedAccountIds, selectedCategoryIds])

  const groups = useMemo(() => groupSpend(filtered, groupBy, accountsById), [filtered, groupBy, accountsById])
  const topGroups = useMemo(() => topNWithOther(groups, 12), [groups])
  const buckets = useMemo(() => monthlyBuckets(filtered, range.start, range.end), [filtered, range])
  const cardSpend = useMemo(() => perCardSpend(filtered, accounts), [filtered, accounts])
  const totalSpend = useMemo(() => groups.reduce((s, g) => s + g.total, 0), [groups])
  const totalIncome = useMemo(
    () => filtered.reduce((s, t) => (t.amount < 0 ? s + Math.abs(t.amount) : s), 0),
    [filtered],
  )

  const groupColorOf = (g: { id: string; color?: string }, index: number) =>
    g.id === '__other__' ? OTHER_COLOR : seriesColor(groupBy, index, g.color)

  const exportCsv = () => {
    const csv = rowsToCsv(
      ['Group', 'Spend'],
      groups.map((g) => [g.label, g.total.toFixed(2)]),
    )
    downloadCsv(`reports-${groupBy}-${range.start}-to-${range.end}.csv`, csv)
  }

  const accountFilterLabel =
    selectedAccountIds == null ? 'All accounts' : `${selectedAccountIds.length} selected`
  const categoryFilterLabel =
    selectedCategoryIds == null ? 'All categories' : `${selectedCategoryIds.length} selected`

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Reports</h1>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={groups.length === 0}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* ── Controls ── */}
      <section className="card-surface flex flex-col gap-5 p-4 md:p-6">
        <div className="flex flex-wrap items-end gap-4">
          {/* Date-range presets */}
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">Date range</span>
            <div className="inline-flex flex-wrap gap-1 rounded-lg border border-outline-variant/50 p-1">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPreset(p.value)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    preset === p.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {preset === 'custom' && (
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reports-start" className="eyebrow">From</Label>
                <Input
                  id="reports-start"
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reports-end" className="eyebrow">To</Label>
                <Input
                  id="reports-end"
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
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
                  onClick={() => setGroupBy(g.value)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    groupBy === g.value
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
                    onClick={() => setSelectedAccountIds(null)}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setSelectedAccountIds([])}
                  >
                    None
                  </button>
                </div>
                {accounts.map((a) => {
                  const checked = selectedAccountIds == null || selectedAccountIds.includes(a.id)
                  return (
                    <label
                      key={a.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleAccount(a.id)} />
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
                    onClick={() => setSelectedCategoryIds(null)}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setSelectedCategoryIds([])}
                  >
                    None
                  </button>
                </div>
                {sortedCategories.map((c: Category) => {
                  const checked =
                    selectedCategoryIds == null || selectedCategoryIds.includes(c.id)
                  return (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleCategory(c.id)} />
                      <span className="truncate">{c.name}</span>
                    </label>
                  )
                })}
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                  <Checkbox
                    checked={
                      selectedCategoryIds == null ||
                      selectedCategoryIds.includes(UNCATEGORIZED_KEY)
                    }
                    onCheckedChange={() => toggleCategory(UNCATEGORIZED_KEY)}
                  />
                  <span className="truncate text-muted-foreground">Uncategorized</span>
                </label>
              </div>
            </details>
          </div>

          {/* Exclude toggles */}
          <div className="flex flex-col gap-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch checked={excludeTransfers} onCheckedChange={setExcludeTransfers} />
              Exclude transfers
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch checked={excludeIgnored} onCheckedChange={setExcludeIgnored} />
              Exclude ignored in spending plan
            </label>
          </div>
        </div>
      </section>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : filtered.length === 0 ? (
        <section className="card-surface p-12 text-center">
          <p className="text-lg font-medium">No transactions match</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a wider date range or loosen the filters.
          </p>
        </section>
      ) : (
        <>
          {/* ── Summary ── */}
          <section className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <div className="card-surface p-4">
              <p className="eyebrow">Total spend</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{formatCurrency(totalSpend)}</p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Total income</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-money-income">
                {formatCurrency(totalIncome)}
              </p>
            </div>
            <div className="card-surface p-4">
              <p className="eyebrow">Transactions</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{filtered.length}</p>
            </div>
          </section>

          {/* ── Bar + donut ── */}
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="card-surface p-4 md:p-6">
              <h2 className="eyebrow mb-4">Spend by {groupBy}</h2>
              {topGroups.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No spend in this range.</p>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(220, topGroups.length * 38 + 48)}>
                  <BarChart data={[...topGroups].reverse()} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={130}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      contentStyle={chartTooltipStyle}
                      itemStyle={chartTooltipItemStyle}
                      formatter={(value: number) => [formatCurrency(value), 'Spend']}
                    />
                    <Bar dataKey="total" radius={[0, 6, 6, 0]} barSize={22}>
                      {[...topGroups].reverse().map((g, i) => (
                        <Cell key={g.id} fill={groupColorOf(g, topGroups.length - 1 - i)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="card-surface p-4 md:p-6">
              <h2 className="eyebrow mb-4">Spend share</h2>
              {topGroups.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No spend in this range.</p>
              ) : (
                <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
                  <div className="mx-auto h-[240px] w-[240px] flex-shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={topGroups}
                          dataKey="total"
                          nameKey="label"
                          innerRadius={62}
                          outerRadius={92}
                          paddingAngle={2}
                          strokeWidth={2}
                          stroke="hsl(var(--surface-container))"
                        >
                          {topGroups.map((g, i) => (
                            <Cell key={g.id} fill={groupColorOf(g, i)} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={chartTooltipStyle}
                          itemStyle={chartTooltipItemStyle}
                          formatter={(value: number, name: string) => [
                            `${formatCurrency(value)} · ${totalSpend > 0 ? ((value / totalSpend) * 100).toFixed(1) : 0}%`,
                            name,
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="max-h-[240px] min-w-0 flex-1 space-y-1 overflow-y-auto pr-1">
                    {topGroups.map((g, i) => (
                      <div key={g.id} className="flex items-center gap-2.5 rounded px-2 py-1 text-sm">
                        <span
                          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                          style={{ background: groupColorOf(g, i) }}
                        />
                        <span className="min-w-0 flex-1 truncate">{g.label}</span>
                        <span className="flex-shrink-0 font-medium tabular-nums">{formatCurrency(g.total)}</span>
                        <span className="w-11 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {totalSpend > 0 ? ((g.total / totalSpend) * 100).toFixed(1) : 0}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ── Monthly trend ── */}
          <section className="card-surface p-4 md:p-6">
            <h2 className="eyebrow mb-4">Monthly income vs spending</h2>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={buckets} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
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
                <Line
                  type="monotone"
                  dataKey="spend"
                  name="Spending"
                  stroke={SPEND_LINE}
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="income"
                  name="Income"
                  stroke={INCOME_LINE}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </section>

          {/* ── Per-card spend ── */}
          <section className="card-surface p-4 md:p-6">
            <h2 className="eyebrow mb-4">Per-card spend</h2>
            {cardSpend.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No spend on credit accounts in this range.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Card</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cardSpend.map((c) => (
                    <TableRow key={c.accountId}>
                      <TableCell className="font-medium">{c.accountName}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(c.total)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {totalSpend > 0 ? ((c.total / totalSpend) * 100).toFixed(1) : 0}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  )
}
