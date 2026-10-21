// Reports — Simplifi-style report picker. Report types mirror Simplifi's
// gallery: Spending, Spending Summary, Income, Income Summary, Income &
// Expense, Net Worth, Taxes, Savings, Monthly Summary — plus PocketLens's own
// Forecast (live spending-plan baseline projection). Reports can be saved (name + type +
// range + grouping + filters, kept in localStorage) and reopened from the
// home. Trailing 12 months is the default range. Sign convention: amount > 0
// = outflow, amount < 0 = inflow; spend vs income follows category type
// (lib/classify). Transfer and ignored exclusions are applied client-side so
// toggling is instant.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { hierarchical } from '@/lib/categoryTree'
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
import {
  AlignLeft,
  ArrowLeftRight,
  Bookmark,
  BookmarkPlus,
  CalendarDays,
  Check,
  ChevronDown as ChevronDownIcon,
  ChevronUp,
  Coins,
  Columns2,
  CreditCard,
  Download,
  Filter as FilterIcon,
  HandCoins,
  Home,
  Landmark,
  MoreVertical,
  PieChart as PieIcon,
  PiggyBank,
  Printer,
  Rows3,
  Search,
  Table2,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconToggle, SelectMenu, ToolbarButton, ToolbarMenu, UnderlineTabs } from '@/components/simplifi/Toolbar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  useCategoryGroups,
  useTransactionsRange,
} from '@/data/hooks'
import {
  applyExcludes,
  expandSplits,
  groupFlow,
  groupKeyFor,
  groupSpend,
  monthlyBuckets,
  reportFlow,
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
import { displayName, type Account, type Transaction, type UUID } from '@/types/domain'
import ForecastSection from '@/components/reports/ForecastSection'
import { ReportTreeTable } from '@/components/reports/ReportTreeTable'
import { BalanceReport } from '@/components/reports/BalanceReport'
import { ChurningReport } from '@/components/reports/ChurningReport'
import { buildCategoryTree, buildGroupTree, buildTaxTree, findNode, type TreeNode } from '@/lib/reportTree'

type ReportId =
  | 'spending'
  | 'summary'
  | 'income'
  | 'income-summary'
  | 'income-expense'
  | 'monthly-summary'
  | 'net-worth'
  | 'taxes'
  | 'savings'
  | 'churning'
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
  { value: 'custom', label: 'Custom range' },
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
  { value: 'merchant', label: 'Payee' },
  { value: 'account', label: 'Account' },
  { value: 'tag', label: 'Tag' },
]

/** id → category, for rolling subcategories up to their top-level category. */
function useCategoryMap() {
  const { data: categories = [] } = useCategories()
  return useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
}

/** The header's download button calls whatever the open report registers here. */
type ExportRef = { current: (() => void) | null }

/** Register the open report's CSV exporter with the header (after each render). */
function useExport(ref: ExportRef, fn: () => void) {
  useEffect(() => {
    ref.current = fn
  })
}

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  category: 'Category',
  merchant: 'Payee',
  account: 'Account',
  tag: 'Tag',
}

/** Flatten a report tree to CSV rows (path, date, account, payee, amount). */
function treeCsv(root: TreeNode, accountsById: Map<UUID, Account>): string {
  const rows: string[][] = []
  const walk = (n: TreeNode, path: string[]) => {
    for (const c of n.children) walk(c, [...path, c.label])
    for (const t of n.txns)
      rows.push([path.join(' > '), t.effective_date, accountsById.get(t.account_id)?.name ?? '', displayName(t), Math.abs(t.amount).toFixed(2)])
  }
  walk(root, [])
  return rowsToCsv(['Group', 'Date', 'Account', 'Payee', 'Amount'], rows)
}

const GROUP_BY_PLURAL: Record<GroupBy, string> = {
  category: 'categories',
  merchant: 'payees',
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

interface InitialFilters {
  preset?: Preset
  groupBy?: GroupBy
  excludeTransfers?: boolean
  excludeIgnored?: boolean
}

function useReportFilters(initial: InitialFilters = {}): FilterState {
  const [preset, setPreset] = useState<Preset>(initial.preset ?? 'last-12')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>(initial.groupBy ?? 'category')
  const [selectedAccountIds, setSelectedAccountIds] = useState<UUID[] | null>(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<UUID[] | null>(null)
  const [excludeTransfers, setExcludeTransfers] = useState(initial.excludeTransfers ?? true)
  const [excludeIgnored, setExcludeIgnored] = useState(initial.excludeIgnored ?? true)

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
  let txns = applyExcludes(expandSplits(allTxns), {
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
  const { data: allTxns = [], isLoading } = useTransactionsRange(range.start, range.end, { byPostedDate: true })

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

/** Simplifi's report toolbar card: date range ▾ · Filters ▾ · Compare ▾ on the
 *  left, view/grouping dropdowns on the right. Every report shares it. */
function FilterBar({
  f,
  compare,
  right,
  showGroupBy = true,
  showFilters = true,
}: {
  f: FilterState
  compare?: { on: boolean; set: (on: boolean) => void }
  right?: ReactNode
  showGroupBy?: boolean
  showFilters?: boolean
}) {
  const { data: accounts = [] } = useAccountsWithBalance()
  const { data: categories = [] } = useCategories()
  const activeFilters =
    (f.selectedAccountIds ? 1 : 0) + (f.selectedCategoryIds ? 1 : 0) + (f.excludeTransfers ? 0 : 1) + (f.excludeIgnored ? 0 : 1)

  return (
    <div className="card-surface flex flex-wrap items-center gap-3 p-3 md:p-4">
      <SelectMenu icon={CalendarDays} value={f.preset} options={PRESETS} onChange={f.setPreset} ariaLabel="Date range" />
      {f.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <Label htmlFor="reports-start" className="sr-only">
            From
          </Label>
          <Input id="reports-start" type="date" value={f.customStart} onChange={(e) => f.setCustomStart(e.target.value)} className="h-9 w-40" />
          <span className="text-muted-foreground">–</span>
          <Label htmlFor="reports-end" className="sr-only">
            To
          </Label>
          <Input id="reports-end" type="date" value={f.customEnd} onChange={(e) => f.setCustomEnd(e.target.value)} className="h-9 w-40" />
        </div>
      )}
      {showFilters && (
        <ToolbarMenu icon={FilterIcon} label={activeFilters > 0 ? `Filters (${activeFilters})` : 'Filters'} contentClassName="w-72">
          <DropdownMenuLabel>Include</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={f.excludeTransfers} onCheckedChange={(v) => f.setExcludeTransfers(!!v)} onSelect={(e) => e.preventDefault()}>
            Exclude transfers
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={f.excludeIgnored} onCheckedChange={(v) => f.setExcludeIgnored(!!v)} onSelect={(e) => e.preventDefault()}>
            Exclude ignored
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              Accounts{f.selectedAccountIds ? ` (${f.selectedAccountIds.length})` : ''}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); f.setSelectedAccountIds(null) }}>All accounts</DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); f.setSelectedAccountIds([]) }}>None</DropdownMenuItem>
              <DropdownMenuSeparator />
              {accounts.map((a) => (
                <DropdownMenuCheckboxItem
                  key={a.id}
                  checked={f.selectedAccountIds == null || f.selectedAccountIds.includes(a.id)}
                  onCheckedChange={() => f.toggleAccount(a.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {a.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              Categories{f.selectedCategoryIds ? ` (${f.selectedCategoryIds.length})` : ''}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); f.setSelectedCategoryIds(null) }}>All categories</DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); f.setSelectedCategoryIds([]) }}>None</DropdownMenuItem>
              <DropdownMenuSeparator />
              {hierarchical(categories).map(({ c, label }) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={f.selectedCategoryIds == null || f.selectedCategoryIds.includes(c.id)}
                  onCheckedChange={() => f.toggleCategory(c.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </ToolbarMenu>
      )}
      {compare && (
        <SelectMenu
          icon={Columns2}
          value={compare.on ? 'prior' : 'none'}
          options={[
            { value: 'none', label: 'Compare' },
            { value: 'prior', label: 'Compare: prior period' },
          ]}
          onChange={(v) => compare.set(v === 'prior')}
          ariaLabel="Compare"
        />
      )}
      <div className="ml-auto flex flex-wrap items-center gap-3">
        {right}
        {showGroupBy && (
          <SelectMenu icon={Rows3} value={f.groupBy} options={GROUP_BYS} onChange={f.setGroupBy} ariaLabel="Group by" align="end" />
        )}
      </div>
    </div>
  )
}

// ─── spending report ─────────────────────────────────────────────────────────

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

const LEGEND_N = 13

function fmtRangeDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })
}

function FlowReport({ f, flow, exportRef }: { f: FilterState; flow: ReportFlow; exportRef: ExportRef }) {
  const { range, filtered, isLoading } = useFilteredTransactions(f)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const categoriesById = useCategoryMap()
  const { data: categories = [] } = useCategories()
  const { data: categoryGroups = [] } = useCategoryGroups()

  const [chart, setChart] = useState<'pie' | 'bar'>('pie')
  const [chartOpen, setChartOpen] = useState(true)
  const [view, setView] = useState<'transaction' | 'summary'>('transaction')
  const [showAll, setShowAll] = useState(false)
  const [focus, setFocus] = useState<ReportGroup | null>(null)

  // Compare to the immediately-prior period of the same length (Simplifi's
  // Compare). Same filters applied to the prior fetch.
  const [compare, setCompare] = useState(false)
  const prior = useMemo(() => priorRange(range), [range])
  const { data: priorTxns = [] } = useTransactionsRange(prior.start, prior.end, {
    enabled: compare,
    byPostedDate: true,
  })
  const priorFiltered = useMemo(
    () => (compare ? applyFilters(f, priorTxns) : []),
    [compare, priorTxns, f.excludeTransfers, f.excludeIgnored, f.selectedAccountIds, f.selectedCategoryIds], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const priorByGroup = useMemo(() => {
    const map = new Map<string, number>()
    for (const g of groupFlow(priorFiltered, flow, f.groupBy, accountsById, categoriesById)) map.set(g.id, g.total)
    return map
  }, [priorFiltered, flow, f.groupBy, accountsById, categoriesById])
  const priorFlowTotal = useMemo(
    () => priorFiltered.reduce((s, t) => (reportFlow(t) === flow ? s + (flow === 'spend' ? t.amount : -t.amount) : s), 0),
    [priorFiltered, flow],
  )

  const stats = useMemo(() => {
    let spend = 0
    let income = 0
    for (const t of filtered) {
      if (reportFlow(t) === 'spend') spend += t.amount
      else income -= t.amount
    }
    return { spend, income, count: filtered.length }
  }, [filtered])
  const flowTotal = flow === 'spend' ? stats.spend : stats.income

  const groups = useMemo(
    () => groupFlow(filtered, flow, f.groupBy, accountsById, categoriesById),
    [filtered, flow, f.groupBy, accountsById, categoriesById],
  )
  // Net credits that land in groups netting ≤ 0 (e.g. reimbursements filed under a
  // non-spend category) aren't charted but are part of the net total.
  const credits = flowTotal - groups.reduce((s, g) => s + g.total, 0)
  const legend = useMemo(
    () =>
      (showAll ? groups : topNWithOther(groups, LEGEND_N)).map((g) =>
        g.id === '__other__' ? { ...g, label: 'Everything else' } : g,
      ),
    [groups, showAll],
  )
  const maxGroup = legend[0]?.total ?? 0

  const tree = useMemo(
    () =>
      f.groupBy === 'category'
        ? buildCategoryTree(filtered, flow, categories, categoryGroups)
        : buildGroupTree(filtered, flow, (t) => groupKeyFor(t, f.groupBy, accountsById)),
    [filtered, flow, categories, categoryGroups, f.groupBy, accountsById],
  )
  const shownTree = useMemo(() => {
    if (!focus || focus.id === '__other__') return tree
    const node = findNode(tree, focus.id)
    return node ? { ...tree, total: node.total, children: [node], txns: [] } : tree
  }, [tree, focus])

  useExport(exportRef, () => {
    const rows: string[][] = []
    const walk = (n: TreeNode, path: string[]) => {
      for (const c of n.children) walk(c, [...path, c.label])
      for (const t of n.txns)
        rows.push([path.join(' > '), t.effective_date, accountsById.get(t.account_id)?.name ?? '', displayName(t), (flow === 'spend' ? t.amount : -t.amount).toFixed(2)])
    }
    walk(shownTree, [])
    downloadCsv(`${flow}-${f.groupBy}-${toISODate(new Date())}.csv`, rowsToCsv([GROUP_BY_LABEL[f.groupBy], 'Date', 'Account', 'Payee', 'Amount'], rows))
  })

  const groupColor = groupColorOf
  const flowWord = flow === 'spend' ? 'expenses' : 'income'

  return (
    <div className="flex flex-col gap-6">
      <FilterBar
        f={f}
        compare={{ on: compare, set: setCompare }}
        right={
          <SelectMenu
            icon={Table2}
            value={view}
            options={[
              { value: 'transaction', label: 'Transaction' },
              { value: 'summary', label: 'Summary' },
            ]}
            onChange={setView}
            ariaLabel="Table detail"
            align="end"
          />
        }
      />

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          <section className="card-surface p-4 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">Total {flowWord}</p>
                <p className="text-2xl font-bold tabular-nums text-foreground">{formatCurrency(flowTotal)}</p>
                <p className="text-sm text-muted-foreground">
                  {fmtRangeDate(range.start)} - {fmtRangeDate(range.end)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stats.count} transactions ·{' '}
                  {flow === 'spend' ? `Income ${formatCurrency(stats.income)}` : `Expenses ${formatCurrency(stats.spend)}`}
                  {Math.abs(credits) > 0.005 && ` · includes ${formatCurrency(credits)} in net credits not charted`}
                </p>
                {compare && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    vs {formatCurrency(priorFlowTotal)} prior period (
                    {priorFlowTotal > 0
                      ? `${flowTotal >= priorFlowTotal ? '+' : ''}${(((flowTotal - priorFlowTotal) / priorFlowTotal) * 100).toFixed(1)}%`
                      : '—'}
                    )
                  </p>
                )}
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
                <ToolbarButton
                  icon={chartOpen ? ChevronUp : ChevronDownIcon}
                  onClick={() => setChartOpen((o) => !o)}
                  aria-label={chartOpen ? 'Collapse chart' : 'Expand chart'}
                />
              </div>
            </div>

            {chartOpen &&
              (legend.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No {flowWord} in this range.</p>
              ) : chart === 'pie' ? (
                <div className="mt-4 grid items-center gap-6 md:grid-cols-[300px_1fr]">
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={legend}
                        dataKey="total"
                        nameKey="label"
                        innerRadius={58}
                        outerRadius={136}
                        strokeWidth={0}
                        onClick={(_: unknown, index: number) => setFocus(legend[index] ?? null)}
                        className="cursor-pointer"
                      >
                        {legend.map((g, i) => (
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
                  <div>
                    <p className="mb-4 text-sm text-foreground">All {GROUP_BY_PLURAL[f.groupBy]}</p>
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-6">
                      {legend.map((g, i) => (
                        <li key={g.id} className="min-w-0">
                          <button
                            type="button"
                            onClick={() => setFocus(focus?.id === g.id ? null : g)}
                            className={cn('flex w-full items-start gap-2 text-left', focus?.id === g.id && 'underline')}
                          >
                            <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: groupColor(g, i) }} aria-hidden />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-foreground">{g.label}</span>
                              <span className="block text-sm font-semibold tabular-nums">{formatCurrency(g.total)}</span>
                              {compare && priorByGroup.get(g.id) != null && (
                                <span className="block text-xs text-muted-foreground">vs {formatCurrency(priorByGroup.get(g.id) ?? 0)}</span>
                              )}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {groups.length > LEGEND_N && (
                      <div className="mt-6 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setShowAll((v) => !v)}
                          className="flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary"
                        >
                          {showAll ? 'Show fewer' : `Show all ${GROUP_BY_PLURAL[f.groupBy]}`}
                          {showAll ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <ul className="mt-4 space-y-2.5">
                  {legend.map((g, i) => (
                    <li key={g.id}>
                      <button type="button" onClick={() => setFocus(focus?.id === g.id ? null : g)} className="flex w-full items-center gap-3 text-left">
                        <span className="w-44 shrink-0 truncate text-sm text-foreground">{g.label}</span>
                        <span className="h-5 flex-1 overflow-hidden rounded bg-muted">
                          <span
                            className="block h-full rounded"
                            style={{ width: `${maxGroup > 0 ? (g.total / maxGroup) * 100 : 0}%`, backgroundColor: groupColor(g, i) }}
                          />
                        </span>
                        <span className="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{formatCurrency(g.total)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </section>

          {shownTree.children.length > 0 && (
            <ReportTreeTable
              root={shownTree}
              title={`${flow === 'spend' ? 'Expense' : 'Income'} transactions by ${GROUP_BY_LABEL[f.groupBy].toLowerCase()}`}
              firstColumn={GROUP_BY_LABEL[f.groupBy]}
              accountsById={accountsById}
              flow={flow}
              summaryOnly={view === 'summary'}
              headerRight={
                focus && (
                  <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                    {focus.label}
                    <button type="button" aria-label="Clear group filter" onClick={() => setFocus(null)}>
                      ×
                    </button>
                  </span>
                )
              }
            />
          )}
        </>
      )}
    </div>
  )
}

// ─── spending summary report ──────────────────────────────────────────────────

const SUMMARY_N = 8

function FlowSummaryReport({ f, flow, exportRef }: { f: FilterState; flow: ReportFlow; exportRef: ExportRef }) {
  const { range, filtered, isLoading } = useFilteredTransactions(f)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const categoriesById = useCategoryMap()

  const tableScrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(tableScrollRef)

  const { groups, monthCols } = useMemo(() => {
    const groups = topNWithOther(groupFlow(filtered, flow, f.groupBy, accountsById, categoriesById), SUMMARY_N)
    const hasOther = groups.some((g) => g.id === '__other__')
    const buckets = monthlyBuckets(filtered, range.start, range.end)
    const monthCols = buckets.map((b) => {
      const bucketTotal = flow === 'spend' ? b.spend : b.income
      const perKey = new Map<string, number>()
      for (const t of filtered) {
        if ((t.date ?? '').slice(0, 7) !== b.monthKey) continue
        if (reportFlow(t) !== flow) continue
        const k = groupKeyFor(t, f.groupBy, accountsById, categoriesById).id
        perKey.set(k, (perKey.get(k) ?? 0) + (flow === 'spend' ? t.amount : -t.amount))
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
  }, [filtered, flow, f.groupBy, accountsById, categoriesById, range.start, range.end])

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

  useExport(exportRef, function exportSummaryCsv() {
    const csv = rowsToCsv(
      ['Group', ...monthCols.map((c) => c.label), 'Total'],
      groups.map((g, i) => [
        g.label,
        ...monthCols.map((c) => (c.cells[i] ?? 0).toFixed(2)),
        g.total.toFixed(2),
      ]),
    )
    downloadCsv(`${flow}-summary-${f.groupBy}-${toISODate(new Date())}.csv`, csv)
  })


  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} />

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          <section className="card-surface p-4 md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">
                Monthly {flow === 'spend' ? 'spending' : 'income'} by {GROUP_BY_LABEL[f.groupBy].toLowerCase()}
              </h2>
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

function IncomeExpenseReport({ f, exportRef }: { f: FilterState; exportRef: ExportRef }) {
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

  useExport(exportRef, function exportCsv() {
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
  })


  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} showGroupBy={false} />
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
              <h2 className="text-base font-semibold text-foreground">Income vs expenses by month</h2>
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
  const { data: allTxns = [], isLoading } = useTransactionsRange(start, end, { byPostedDate: true })
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const categoriesById = useCategoryMap()

  const txns = useMemo(
    () => applyExcludes(allTxns, { excludeTransfers: true, excludeIgnored: true }),
    [allTxns],
  )
  const stats = useMemo(() => {
    let spend = 0
    let income = 0
    for (const t of txns) {
      if (reportFlow(t) === 'spend') spend += t.amount
      else income -= t.amount
    }
    return { spend, income }
  }, [txns])
  const topSpend = useMemo(
    () => groupSpend(txns, 'category', accountsById, categoriesById).slice(0, 5),
    [txns, accountsById, categoriesById],
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

// ─── taxes / net worth / savings ──────────────────────────────────────────────

function TaxesReport({ f, exportRef }: { f: FilterState; exportRef: ExportRef }) {
  const { filtered, isLoading } = useFilteredTransactions(f)
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const { data: categories = [] } = useCategories()
  const { data: categoryGroups = [] } = useCategoryGroups()
  const tree = useMemo(() => buildTaxTree(filtered, categories, categoryGroups), [filtered, categories, categoryGroups])
  useExport(exportRef, () => downloadCsv(`taxes-${toISODate(new Date())}.csv`, treeCsv(tree, accountsById)))
  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} showGroupBy={false} />
      <p className="text-xs text-muted-foreground">
        Taxable income is every income-category inflow. Tax payments &amp; deductions are spend in
        categories named for taxes, charity, medical, education, childcare, or mortgage interest.
        PocketLens has no tax-form line mapping, so treat this as a worksheet, not tax advice.
      </p>
      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : tree.children.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No tax-related activity in this range.</p>
      ) : (
        <ReportTreeTable root={tree} title="Tax detail" firstColumn="Personal" accountsById={accountsById} flow="mixed" />
      )}
    </div>
  )
}

function BalanceReportView({ f, mode, exportRef }: { f: FilterState; mode: 'net-worth' | 'savings'; exportRef: ExportRef }) {
  const now = useMemo(() => new Date(), [])
  const range = useMemo(() => rangeFor(f.preset, now, f.customStart, f.customEnd), [f.preset, f.customStart, f.customEnd, now])
  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} showGroupBy={false} showFilters={false} />
      <BalanceReport mode={mode} start={range.start} end={range.end} exportRef={exportRef} />
    </div>
  )
}

function ChurningReportView({ f, exportRef }: { f: FilterState; exportRef: ExportRef }) {
  const now = useMemo(() => new Date(), [])
  const range = useMemo(() => rangeFor(f.preset, now, f.customStart, f.customEnd), [f.preset, f.customStart, f.customEnd, now])
  return (
    <div className="flex flex-col gap-6">
      <FilterBar f={f} showGroupBy={false} showFilters={false} />
      <ChurningReport start={range.start} end={range.end} exportRef={exportRef} />
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

const REPORT_CARDS: { id: ReportId; title: string; hint: string; icon: LucideIcon; tint: string }[] = [
  { id: 'spending', title: 'Spending', hint: 'See where your money goes', icon: Wallet, tint: 'bg-violet-100 text-violet-700' },
  { id: 'summary', title: 'Spending Summary', hint: 'View your spending over time', icon: Wallet, tint: 'bg-violet-100 text-violet-700' },
  { id: 'income', title: 'Income', hint: 'Track your sources of income', icon: HandCoins, tint: 'bg-emerald-100 text-emerald-700' },
  { id: 'income-summary', title: 'Income Summary', hint: 'View your income over time', icon: HandCoins, tint: 'bg-emerald-100 text-emerald-700' },
  { id: 'income-expense', title: 'Income & Expense', hint: 'Compare income and expenses', icon: ArrowLeftRight, tint: 'bg-emerald-100 text-emerald-700' },
  { id: 'net-worth', title: 'Net Worth', hint: 'Your net worth over time', icon: Coins, tint: 'bg-fuchsia-100 text-fuchsia-700' },
  { id: 'taxes', title: 'Taxes', hint: 'Taxable income and deductions', icon: Landmark, tint: 'bg-cyan-100 text-cyan-700' },
  { id: 'savings', title: 'Savings', hint: 'Savings progress over time', icon: PiggyBank, tint: 'bg-rose-100 text-rose-700' },
  { id: 'churning', title: 'Churning', hint: 'Annual fees vs. credits sold and bonuses', icon: CreditCard, tint: 'bg-violet-100 text-violet-700' },
]

const WIDE_CARDS: { id: ReportId; title: string; hint: string; chip: string; icon: LucideIcon; tint: string }[] = [
  {
    id: 'monthly-summary',
    title: 'Monthly Summary',
    hint: 'A snapshot of your income, spending, and goals for the month.',
    chip: 'Snapshot',
    icon: CalendarDays,
    tint: 'bg-orange-100 text-orange-700',
  },
  {
    id: 'forecast',
    title: 'Forecast',
    hint: 'Where you are headed — projected net worth from your live plan baseline plus adjustments.',
    chip: 'Projection',
    icon: TrendingUp,
    tint: 'bg-sky-100 text-sky-700',
  },
]

const REPORT_ICON: Record<ReportId, { icon: LucideIcon; tint: string }> = Object.fromEntries(
  [...REPORT_CARDS, ...WIDE_CARDS].map((c) => [c.id, { icon: c.icon, tint: c.tint }]),
) as Record<ReportId, { icon: LucideIcon; tint: string }>

function ReportsHome({
  query,
  onSelect,
  saved,
  onOpenSaved,
  onDeleteSaved,
}: {
  query: string
  onSelect: (id: ReportId) => void
  saved: SavedReport[]
  onOpenSaved: (r: SavedReport) => void
  onDeleteSaved: (id: string) => void
}) {
  const q = query.trim().toLowerCase()
  const cards = REPORT_CARDS.filter((r) => r.title.toLowerCase().includes(q))
  const wide = WIDE_CARDS.filter((r) => r.title.toLowerCase().includes(q))
  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0 flex-1">
        <h2 className="mb-3 text-lg font-semibold text-foreground">New report</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((r) => (
            <button key={r.id} type="button" onClick={() => onSelect(r.id)} className="report-card card-surface border border-border p-4 text-left transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span className={cn('mb-4 flex h-10 w-10 items-center justify-center rounded-lg', r.tint)}>
                <r.icon className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="text-base font-semibold text-foreground">{r.title}</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">{r.hint}</p>
            </button>
          ))}
        </div>
        <div className="mt-6 flex flex-col gap-3">
          {wide.map((r) => (
            <button key={r.id} type="button" onClick={() => onSelect(r.id)} className="report-card card-surface flex items-center gap-4 border border-border p-4 text-left transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', r.tint)}>
                <r.icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-foreground">{r.title}</span>
                <span className="block text-sm text-muted-foreground">{r.hint}</span>
              </span>
              <span className="rounded-md bg-surface-container-high px-2 py-1 text-xs font-medium text-muted-foreground">{r.chip}</span>
            </button>
          ))}
        </div>
        {cards.length === 0 && wide.length === 0 && (
          <p className="text-sm text-muted-foreground">No reports match “{query}”.</p>
        )}
      </div>

      <aside aria-label="Saved reports" className="w-full shrink-0 lg:w-[340px] lg:border-l lg:border-border lg:pl-6">
        <h2 className="mb-3 border-b border-border pb-3 text-lg font-semibold text-foreground">Saved reports</h2>
        {saved.length === 0 ? (
          <p className="text-sm text-muted-foreground">Save a report to keep its range, grouping and filters.</p>
        ) : (
          <ul className="flex flex-col">
            {saved.map((r) => {
              const meta = REPORT_ICON[r.report]
              return (
                <li key={r.id} className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-accent">
                  <button type="button" onClick={() => onOpenSaved(r)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', meta.tint)}>
                      <meta.icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-foreground">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {PRESETS.find((p) => p.value === r.preset)?.label ?? r.preset}
                      </span>
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`Options for ${r.name}`} className="rounded p-1 text-muted-foreground hover:text-foreground">
                        <MoreVertical className="h-4 w-4" aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onOpenSaved(r)}>Open</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onDeleteSaved(r.id)} aria-label={`Delete saved report ${r.name}`}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        )}
      </aside>
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
  'net-worth': 'Net Worth',
  taxes: 'Taxes',
  savings: 'Savings',
  churning: 'Churning',
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
  'net-worth',
  'taxes',
  'savings',
  'churning',
]

/** Default range per report type (Simplifi's defaults). */
const DEFAULT_PRESET: Partial<Record<ReportId, Preset>> = {
  'net-worth': 'last-6',
  savings: 'last-6',
  taxes: 'ytd',
  churning: 'ytd',
}

interface ReportTabState {
  key: string
  report: ReportId
  saved?: SavedReport
}

/** One open report tab: its own filters, header actions, and body. Kept mounted
 *  while hidden so switching tabs preserves each tab's state. */
function ReportTab({
  tab,
  hidden,
  onSave,
  onDeleteSaved,
}: {
  tab: ReportTabState
  hidden: boolean
  onSave: (tab: ReportTabState, f: FilterState) => SavedReport | null
  onDeleteSaved: (id: string) => void
}) {
  const f = useReportFilters(
    tab.saved
      ? { preset: tab.saved.preset, groupBy: tab.saved.groupBy, excludeTransfers: tab.saved.excludeTransfers, excludeIgnored: tab.saved.excludeIgnored }
      : { preset: DEFAULT_PRESET[tab.report] },
  )
  const exportRef: ExportRef = useRef(null)
  const [savedAs, setSavedAs] = useState<SavedReport | undefined>(tab.saved)
  const unchanged =
    savedAs != null &&
    savedAs.preset === f.preset &&
    savedAs.groupBy === f.groupBy &&
    savedAs.excludeTransfers === f.excludeTransfers &&
    savedAs.excludeIgnored === f.excludeIgnored
  const canSave = FILTERED_REPORTS.includes(tab.report)

  return (
    <div hidden={hidden} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">{savedAs?.name ?? REPORT_TITLES[tab.report]}</h2>
          <p className="text-sm text-muted-foreground">{REPORT_TITLES[tab.report]}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {canSave && (
            <button
              type="button"
              disabled={unchanged}
              onClick={() => {
                const r = onSave(tab, f)
                if (r) setSavedAs(r)
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-surface-container-high disabled:text-muted-foreground"
            >
              {unchanged ? <Check className="h-4 w-4" aria-hidden /> : <BookmarkPlus className="h-4 w-4" aria-hidden />}
              {unchanged ? 'Saved' : 'Save'}
            </button>
          )}
          <ToolbarButton icon={Download} aria-label="Download CSV" onClick={() => exportRef.current?.()} />
          <ToolbarButton icon={Printer} aria-label="Print / PDF" onClick={() => window.print()} />
          {savedAs && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ToolbarButton icon={MoreVertical} aria-label="More report options" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    onDeleteSaved(savedAs.id)
                    setSavedAs(undefined)
                  }}
                >
                  Delete saved report
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {tab.report === 'spending' && <FlowReport f={f} flow="spend" exportRef={exportRef} />}
      {tab.report === 'summary' && <FlowSummaryReport f={f} flow="spend" exportRef={exportRef} />}
      {tab.report === 'income' && <FlowReport f={f} flow="income" exportRef={exportRef} />}
      {tab.report === 'income-summary' && <FlowSummaryReport f={f} flow="income" exportRef={exportRef} />}
      {tab.report === 'income-expense' && <IncomeExpenseReport f={f} exportRef={exportRef} />}
      {tab.report === 'monthly-summary' && <MonthlySummaryReport />}
      {tab.report === 'net-worth' && <BalanceReportView f={f} mode="net-worth" exportRef={exportRef} />}
      {tab.report === 'taxes' && <TaxesReport f={f} exportRef={exportRef} />}
      {tab.report === 'savings' && <BalanceReportView f={f} mode="savings" exportRef={exportRef} />}
      {tab.report === 'churning' && <ChurningReportView f={f} exportRef={exportRef} />}
      {tab.report === 'forecast' && <ForecastSection />}
    </div>
  )
}

export default function ReportsPage() {
  // ?open=<report> (e.g. the Churning page's "View report") opens that report.
  const [searchParams] = useSearchParams()
  const [tabs, setTabs] = useState<ReportTabState[]>(() => {
    const id = searchParams.get('open') as ReportId | null
    return id && id in REPORT_TITLES ? [{ key: 't-initial', report: id }] : []
  })
  const [active, setActive] = useState<string>(() => tabs[0]?.key ?? 'home')
  const [saved, setSaved] = useState<SavedReport[]>(() => loadSavedReports())
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  function open(report: ReportId, savedReport?: SavedReport) {
    const existing = savedReport ? tabs.find((t) => t.saved?.id === savedReport.id) : undefined
    if (existing) {
      setActive(existing.key)
      return
    }
    const key = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setTabs((prev) => [...prev, { key, report, saved: savedReport }])
    setActive(key)
  }

  function close(key: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key)
      if (active === key) setActive(next.at(-1)?.key ?? 'home')
      return next
    })
  }

  function deleteSaved(id: string) {
    setSaved((prev) => {
      const next = prev.filter((r) => r.id !== id)
      storeSavedReports(next)
      return next
    })
  }

  function saveTab(tab: ReportTabState, f: FilterState): SavedReport | null {
    const name = window.prompt('Name this report:', tab.saved?.name ?? REPORT_TITLES[tab.report])
    if (!name || !name.trim()) return null
    const entry: SavedReport = {
      id: tab.saved?.id ?? `sr-${Date.now().toString(36)}`,
      name: name.trim(),
      report: tab.report,
      preset: f.preset,
      groupBy: f.groupBy,
      excludeTransfers: f.excludeTransfers,
      excludeIgnored: f.excludeIgnored,
    }
    setSaved((prev) => {
      const next = prev.some((r) => r.id === entry.id) ? prev.map((r) => (r.id === entry.id ? entry : r)) : [...prev, entry]
      storeSavedReports(next)
      return next
    })
    return entry
  }

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
      <UnderlineTabs
        ariaLabel="Open reports"
        value={active}
        onChange={setActive}
        tabs={[
          { value: 'home', label: <><Home className="h-4 w-4" aria-hidden /> Home</> },
          ...tabs.map((t) => ({
            value: t.key,
            label: (
              <>
                {t.saved && <Bookmark className="h-3.5 w-3.5 fill-current" aria-hidden />}
                {t.saved?.name ?? REPORT_TITLES[t.report]}
              </>
            ),
            onClose: () => close(t.key),
          })),
        ]}
        trailing={
          <>
            {searchOpen && (
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search reports"
                aria-label="Search reports"
                className="h-8 w-48"
              />
            )}
            <ToolbarButton
              icon={Search}
              aria-label="Search reports"
              onClick={() => {
                setSearchOpen((o) => !o)
                setActive('home')
              }}
            />
          </>
        }
      />

      {active === 'home' && (
        <ReportsHome
          query={query}
          onSelect={(id) => open(id)}
          saved={saved}
          onOpenSaved={(r) => open(r.report, r)}
          onDeleteSaved={deleteSaved}
        />
      )}
      {tabs.map((t) => (
        <ReportTab key={t.key} tab={t} hidden={active !== t.key} onSave={saveTab} onDeleteSaved={deleteSaved} />
      ))}
    </div>
  )
}
