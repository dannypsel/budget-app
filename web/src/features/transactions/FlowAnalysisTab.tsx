// Transactions ▸ Spending / Income tabs (Simplifi parity): group-by
// (category / payee / tag), date range, Total vs monthly Average, pie/bar toggle,
// top 9 + "Everything else", then a Transaction Activity register with the same
// search syntax as the main register. Clicking a group filters the register.
// Classification follows lib/classify (category type decides; transfers and
// excluded rows never count).

import { useMemo, useState } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { AlignLeft, CalendarDays, Download, PieChart as PieIcon, Rows3, X } from 'lucide-react'
import { IconToggle, SelectMenu, ToolbarButton } from '@/components/simplifi/Toolbar'
import { downloadCsv, transactionsToCsv } from '@/lib/exportCsv'
import { useTransactionsRange } from '@/data/hooks'
import { useDebouncedValue } from '@/hooks/use-debounce'
import { applyExcludes, expandSplits, groupFlow, groupKeyFor, reportFlow, topNWithOther, type GroupBy, type ReportFlow, type ReportGroup } from '@/lib/reports'
import { matchesQuery, parseQuery } from '@/lib/searchDsl'
import { formatCurrency } from '@/lib/money'
import { toISODate } from '@/lib/dates'
import { chartTooltipItemStyle, chartTooltipLabelStyle, chartTooltipStyle } from '@/lib/chartTooltip'
import { cn } from '@/lib/utils'
import { TransactionTable, type RegisterColumns } from './TransactionTable'
import { TransactionSearchBox } from './TransactionSearchBox'
import type { Account, Category, Transaction, UUID } from '@/types/domain'

type Preset = 'this-month' | 'last-month' | 'last-3' | 'last-6' | 'last-12' | 'ytd' | 'last-year'
const PRESETS: { value: Preset; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-3', label: 'Recent 3 months' },
  { value: 'last-6', label: 'Recent 6 months' },
  { value: 'last-12', label: 'Recent 12 months' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last-year', label: 'Last year' },
]
const GROUPINGS: { value: GroupBy; label: string }[] = [
  { value: 'category', label: 'By category' },
  { value: 'merchant', label: 'By payee' },
  { value: 'tag', label: 'By tag' },
]
const ACTIVITY_COLUMNS: RegisterColumns = { account: true, reviewed: false, category: true, tags: false, exclusion: true }
const TOP_N = 9
const PALETTE = ['#4318FF', '#8FE3F7', '#4CC38A', '#F09A6B', '#E6D84E', '#6E5BD8', '#F0604D', '#B85BD8', '#D8F06B', '#9AA3AE']

function presetRange(p: Preset, now: Date): { start: string; end: string; months: number } {
  const y = now.getFullYear()
  const m = now.getMonth()
  const first = (yy: number, mm: number) => toISODate(new Date(yy, mm, 1))
  const today = toISODate(now)
  switch (p) {
    case 'this-month':
      return { start: first(y, m), end: today, months: 1 }
    case 'last-month':
      return { start: first(y, m - 1), end: toISODate(new Date(y, m, 0)), months: 1 }
    case 'last-3':
      return { start: first(y, m - 2), end: today, months: 3 }
    case 'last-6':
      return { start: first(y, m - 5), end: today, months: 6 }
    case 'last-12':
      return { start: first(y, m - 11), end: today, months: 12 }
    case 'ytd':
      return { start: `${y}-01-01`, end: today, months: m + 1 }
    case 'last-year':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31`, months: 12 }
  }
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })

export function FlowAnalysisTab({
  flow,
  accountsById,
  categoriesById,
  onSelect,
  onToggleReviewed,
}: {
  flow: ReportFlow
  accountsById: Map<UUID, Account>
  categoriesById: Map<UUID, Category>
  onSelect: (t: Transaction) => void
  onToggleReviewed: (t: Transaction) => void
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>('category')
  const [preset, setPreset] = useState<Preset>('last-12')
  const [chart, setChart] = useState<'pie' | 'bar'>('pie')
  const [measure, setMeasure] = useState<'total' | 'average'>('total')
  const [focus, setFocus] = useState<ReportGroup | null>(null)
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query)

  const now = useMemo(() => new Date(), [])
  const range = useMemo(() => presetRange(preset, now), [preset, now])
  const { data: raw = [], isLoading } = useTransactionsRange(range.start, range.end, { byPostedDate: true })

  const rows = useMemo(
    () => applyExcludes(raw, { excludeTransfers: true, excludeIgnored: true }).filter((t) => reportFlow(t) === flow),
    [raw, flow],
  )
  const groups = useMemo(
    () => groupFlow(expandSplits(rows), flow, groupBy, accountsById, categoriesById),
    [rows, flow, groupBy, accountsById, categoriesById],
  )
  const top = useMemo(
    () => topNWithOther(groups, TOP_N).map((g) => (g.id === '__other__' ? { ...g, label: 'Everything else' } : g)),
    [groups],
  )
  const divisor = measure === 'average' ? Math.max(range.months, 1) : 1
  // Net of credits, same as the Spending report total (groups netting ≤ 0 aren't charted).
  const total = rows.reduce((sum, t) => sum + (flow === 'spend' ? t.amount : -t.amount), 0) / divisor
  const pieData = useMemo(() => top.map((g) => ({ ...g, total: g.total / divisor })), [top, divisor])
  const colorOf = (g: ReportGroup, i: number) => (groupBy === 'category' && g.color) || PALETTE[i % PALETTE.length]

  const parsed = useMemo(() => parseQuery(debounced), [debounced])
  const activity = useMemo(() => {
    const topIds = new Set(top.filter((g) => g.id !== '__other__').map((g) => g.id))
    return rows.filter((t) => {
      if (focus) {
        const id = groupKeyFor(t, groupBy, accountsById, categoriesById).id
        if (focus.id === '__other__' ? topIds.has(id) : id !== focus.id) return false
      }
      return matchesQuery(t, parsed, { accountsById, categoriesById })
    })
  }, [rows, focus, top, groupBy, accountsById, categoriesById, parsed])

  const flowWord = flow === 'spend' ? 'expenses' : 'income'

  return (
    <div className="flex flex-col gap-5">
      <section className="card-surface p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
          <SelectMenu icon={Rows3} value={groupBy} options={GROUPINGS} onChange={(v) => { setGroupBy(v); setFocus(null) }} ariaLabel="Group by" />
          <SelectMenu icon={CalendarDays} value={preset} options={PRESETS} onChange={(v) => { setPreset(v); setFocus(null) }} ariaLabel="Date range" />
        </div>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              {measure === 'average' ? 'Average monthly' : 'Total'} {flowWord}
            </p>
            <p className="text-2xl font-bold tabular-nums text-foreground">{formatCurrency(total)}</p>
            <p className="text-sm text-muted-foreground">
              {fmtDate(range.start)} - {fmtDate(range.end)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <IconToggle
              value={chart}
              onChange={setChart}
              ariaLabel="Chart type"
              options={[
                { value: 'pie', icon: PieIcon, label: 'Pie chart' },
                { value: 'bar', icon: AlignLeft, label: 'Bar chart' },
              ]}
            />
            <SelectMenu
              value={measure}
              options={[
                { value: 'total', label: 'Total' },
                { value: 'average', label: 'Average' },
              ]}
              onChange={setMeasure}
              ariaLabel="Total or average"
              align="end"
            />
          </div>
        </div>

        {isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : top.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No {flowWord} in this range.</p>
        ) : chart === 'pie' ? (
          <div className="mt-4 grid items-center gap-6 md:grid-cols-[300px_1fr]">
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="total"
                  nameKey="label"
                  innerRadius={58}
                  outerRadius={136}
                  strokeWidth={0}
                  className="cursor-pointer"
                  onClick={(_: unknown, i: number) => setFocus(top[i] ?? null)}
                >
                  {top.map((g, i) => (
                    <Cell key={g.id} fill={colorOf(g, i)} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={chartTooltipStyle}
                  itemStyle={chartTooltipItemStyle}
                  labelStyle={chartTooltipLabelStyle}
                  formatter={(v: number, name: string) => [formatCurrency(v), name]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div>
              <p className="mb-3 text-sm font-medium text-foreground">
                All {groupBy === 'category' ? 'categories' : groupBy === 'merchant' ? 'payees' : 'tags'}
              </p>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-6">
                {top.map((g, i) => (
                  <li key={g.id} className="min-w-0">
                    <button type="button" onClick={() => setFocus(g)} className={cn('flex w-full items-start gap-2 text-left', focus?.id === g.id && 'underline')}>
                      <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: colorOf(g, i) }} aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground">{g.label}</span>
                        <span className="block text-sm font-semibold tabular-nums">{formatCurrency(g.total / divisor)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <ul className="mt-4 space-y-2.5">
            {top.map((g, i) => (
              <li key={g.id}>
                <button type="button" onClick={() => setFocus(g)} className="flex w-full items-center gap-3 text-left">
                  <span className="w-40 shrink-0 truncate text-sm text-foreground">{g.label}</span>
                  <span className="h-5 flex-1 overflow-hidden rounded bg-muted">
                    <span className="block h-full rounded" style={{ width: `${(g.total / (top[0]?.total || 1)) * 100}%`, backgroundColor: colorOf(g, i) }} />
                  </span>
                  <span className="w-28 shrink-0 text-right text-sm tabular-nums">{formatCurrency(g.total / divisor)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card-surface p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">Transaction Activity</h2>
          {focus && (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {focus.label}
              <button type="button" onClick={() => setFocus(null)} aria-label="Clear group filter">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          )}
          <div className="flex min-w-[260px] flex-1 items-center gap-2 md:ml-auto md:max-w-md">
            <TransactionSearchBox value={query} onChange={setQuery} />
            <ToolbarButton
              icon={Download}
              aria-label="Download CSV"
              onClick={() => downloadCsv(`${flow}-activity-${range.start}-${range.end}.csv`, transactionsToCsv(activity, accountsById))}
            />
          </div>
        </div>
        {activity.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No matching transactions.</p>
        ) : (
          <TransactionTable
            transactions={activity}
            accountsById={accountsById}
            onSelect={onSelect}
            onToggleReviewed={onToggleReviewed}
            columns={ACTIVITY_COLUMNS}
            grouped={false}
          />
        )}
      </section>
    </div>
  )
}
