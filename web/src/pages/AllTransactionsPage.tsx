// Transactions — terracotta/sage layout: search + month filter chips up top, day-grouped
// list in the main column, and (desktop) a right sidebar with the monthly spending summary
// and Top Category cards derived from the already-fetched month of transactions.
// Plain-text search is server-side across all months (search_transactions RPC); a query with
// Simplifi search syntax (payee:, date=, amount>, is:reviewed …, lib/searchDsl) fetches the
// date window it implies and matches client-side. While a query is active the month chips and
// the month-scoped sidebar hide.
// Keeps the Transfers tab (?tab=transfers) and the "To Categorize" swipe review.
// Mirrors PocketLens/Views/Transactions/TransactionsView.swift.

import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import { hierarchical } from '@/lib/categoryTree'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchAttachmentCounts } from '@/data/txnExtras'
import { toast } from 'sonner'
import {
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Filter,
  MoreVertical,
  Plus,
  RotateCcw,
  Search as SearchIcon,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ToolbarButton, ToolbarMenu, UnderlineTabs } from '@/components/simplifi/Toolbar'
import { TransactionTable, type RegisterColumns, type RegisterSort } from '@/features/transactions/TransactionTable'
import { allAccountsTotal } from '@/lib/accountTotals'
import { TransactionSearchBox } from '@/features/transactions/TransactionSearchBox'
import { FlowAnalysisTab } from '@/features/transactions/FlowAnalysisTab'
import { dateWindow, matchesQuery, parseQuery } from '@/lib/searchDsl'
import { TransactionTagControls } from '@/features/transactions/TransactionTagControls'
import { ErrorState } from '@/components/ErrorState'
import { TransfersTab } from '@/features/transactions/TransfersTab'
import { CategorizeReview } from '@/features/transactions/CategorizeReview'
import { CategoryPickerDialog } from '@/components/finance/CategoryPickerDialog'
import CreateTransactionDialog from '@/components/finance/CreateTransactionDialog'
import CsvImportDialog from '@/components/finance/CsvImportDialog'
import AccountsOverview from '@/components/dashboard/AccountsOverview'
import { autoCategorize } from '@/data/aiCategorize'
import { BulkCategorizePrompt, type BulkPrompt } from '@/components/finance/BulkCategorizePrompt'
import { ProgressBar } from '@/components/finance/ProgressBar'
import { iconForSymbol } from '@/lib/iconMap'
import { categoryTint, categorySeriesColor } from '@/lib/categoryColors'
import { CountUp } from '@/lib/motion'
import {
  useBulkCategorizeMerchant,
  useBulkSetCategoryByIds,
  useAccounts,
  useAccountsWithBalance,
  useCategories,
  useRecurringSeries,
  useSetCategory,
  useSeparateAccounts,
  useSetReviewed,
  useSpendByCategory,
  useTransactionSearch,
  useTransactionsMonthAll,
  useTransactionsRange,
  useUncategorized,
} from '@/data/hooks'
import { useDebouncedValue } from '@/hooks/use-debounce'
import { SEARCH_LIMIT, uncategorizedSameMerchant } from '@/data/transactions'
import { formatCurrency } from '@/lib/money'
import { downloadCsv, transactionsToCsv } from '@/lib/exportCsv'
import { formatMonthLabel, toISODate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import {
  displayName,
  merchantKey,
  sumIncome,
  sumNetSpend,
  type NeedWant,
  type SpendPattern,
  type Transaction,
  type UUID,
} from '@/types/domain'

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

/** "Jun 2026" — compact chip label. */
function chipMonthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

/** Simplifi's "All Accounts" header card: total balance across active accounts. */
function AllAccountsCard() {
  const { data: plaid = [] } = useAccountsWithBalance()
  const { data: manual = [] } = useSeparateAccounts()
  const { total, count } = useMemo(() => allAccountsTotal([...plaid, ...manual]), [plaid, manual])
  return (
    <section className="card-surface flex items-center justify-between gap-4 p-5">
      <div>
        <h2 className="text-xl font-semibold text-foreground">All Accounts</h2>
        <p className="text-sm text-muted-foreground">{count} accounts</p>
      </div>
      <p className="text-2xl font-bold tabular-nums text-foreground">{formatCurrency(total)}</p>
    </section>
  )
}

/** Collapsible card shell (Simplifi's Reminders card). */
function CollapsibleCard({
  title,
  defaultOpen,
  storageKey,
  children,
  as: As = 'section',
  ariaLabel,
}: {
  title: string
  defaultOpen: boolean
  storageKey: string
  children: ReactNode
  as?: 'section' | 'aside'
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v == null ? defaultOpen : v === '1'
    } catch {
      return defaultOpen
    }
  })
  const toggle = () =>
    setOpen((prev) => {
      try {
        localStorage.setItem(storageKey, prev ? '0' : '1')
      } catch {
        // Storage blocked — the toggle still works for this session.
      }
      return !prev
    })
  return (
    <As aria-label={ariaLabel} className="card-surface">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center justify-between px-5 py-4 text-left">
        <span className="text-lg font-semibold text-foreground">{title}</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-container-low text-muted-foreground">
          {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </span>
      </button>
      {open && <div className="border-t border-border px-5 py-4">{children}</div>}
    </As>
  )
}

/** PocketLens month summary (Spent / Income / daily spend / Top Category), kept as
 *  a collapsible card above the register. */
function MonthSummaryCard({ month, spent, income, counted }: { month: Date; spent: number; income: number; counted: Transaction[] }) {
  const { data: spendRows = [] } = useSpendByCategory(month)
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const { daily, maxDay } = useMemo(() => {
    const daily = new Array<number>(daysInMonth).fill(0)
    for (const t of counted) {
      if (t.amount <= 0) continue
      const day = Number(t.effective_date.slice(8, 10))
      if (day >= 1 && day <= daysInMonth) daily[day - 1] += t.amount
    }
    let maxDay = 0
    daily.forEach((v, i) => {
      if (v > daily[maxDay]) maxDay = i
    })
    return { daily, maxDay }
  }, [counted, daysInMonth])
  const maxSpend = Math.max(...daily, 1)
  const top = spendRows[0] && spendRows[0].total > 0 ? { category: spendRows[0].category, amount: spendRows[0].total } : null
  const topPct = top && spent > 0 ? Math.round((top.amount / spent) * 100) : 0
  const monthShort = month.toLocaleDateString(undefined, { month: 'short' })

  return (
    <CollapsibleCard title={`Summary · ${formatMonthLabel(month)}`} defaultOpen storageKey="pocketlens.txnSummaryOpen" as="aside" ariaLabel="Month summary">
      <div className="grid gap-6 md:grid-cols-[1fr_1fr_1.4fr]">
        <div>
          {/* Wording keeps "Spent" + "Income" on the page — e2e smoke asserts both in this aside. */}
          <p className="text-sm text-muted-foreground">Spent</p>
          <CountUp value={spent} format={(n) => formatCurrency(n)} className="block text-2xl font-bold tabular-nums text-foreground" />
          <p className="mt-2 flex items-center gap-1 text-sm">
            <span className="text-muted-foreground">Income</span>
            <span className="ml-auto font-semibold tabular-nums text-money-income">+{formatCurrency(income)}</span>
          </p>
        </div>
        <div>
          <div aria-hidden="true" className="flex h-14 w-full items-end gap-px border-b border-border">
            {daily.map((v, i) => (
              <div
                key={i}
                className={cn('flex-1 rounded-t-sm', i === maxDay && v > 0 ? 'bg-primary' : 'bg-surface-variant')}
                style={{ height: `${Math.max((v / maxSpend) * 100, 3)}%` }}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{monthShort} 1</span>
            <span>{monthShort} 15</span>
            <span>
              {monthShort} {daysInMonth}
            </span>
          </div>
        </div>
        {top && (
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              style={{ backgroundColor: categoryTint(top.category.color), color: categorySeriesColor(top.category) }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            >
              {createElement(iconForSymbol(top.category.icon), { className: 'h-5 w-5' })}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Top Category</p>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{top.category.name}</span>
                <span className="text-sm tabular-nums text-foreground">{formatCurrency(top.amount)}</span>
              </div>
              <ProgressBar value={topPct} trackClassName="bg-surface-container-low" />
              <span className="mt-1 block text-xs text-muted-foreground">{topPct}% of this month's spending</span>
            </div>
          </div>
        )}
      </div>
    </CollapsibleCard>
  )
}

const PER_MONTH_FACTORS: Record<string, number> = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, yearly: 1 / 12 }

/** Simplifi's Reminders card, fed by PocketLens's detected recurring series. */
function RemindersCard() {
  const { data: series = [] } = useRecurringSeries()
  const active = useMemo(
    () => series.filter((s) => s.status !== 'ignored').sort((a, b) => a.nextExpected.localeCompare(b.nextExpected)),
    [series],
  )
  const monthly = active.reduce((sum, s) => sum + Math.abs(s.avgAmount) * (PER_MONTH_FACTORS[s.cadence] ?? 1), 0)
  return (
    <CollapsibleCard title="Reminders" defaultOpen={false} storageKey="pocketlens.txnRemindersOpen">
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recurring charges detected yet.</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            Recurring charges ≈ <span className="font-semibold text-foreground">{formatCurrency(monthly)}</span>/mo
          </p>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {active.slice(0, 9).map((s) => (
              <li key={s.merchantKey} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                <RotateCcw className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{s.displayName}</span>
                  <span className="block text-xs text-muted-foreground">
                    Next {new Date(`${s.nextExpected}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {s.cadence}
                  </span>
                </span>
                <span className="text-sm tabular-nums text-foreground">{formatCurrency(Math.abs(s.avgAmount))}</span>
              </li>
            ))}
          </ul>
          <Link to="/recurring" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            See all recurring <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </>
      )}
    </CollapsibleCard>
  )
}

const ACCOUNTS_PANEL_KEY = 'pocketlens.txnAccountsPanel'
const COLUMNS_KEY = 'pocketlens.txnColumns'

/** Simplifi's collapsible Accounts panel beside the register (wide screens only). */
function AccountsPanel() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(ACCOUNTS_PANEL_KEY) !== 'closed'
    } catch {
      return true
    }
  })
  const toggle = () =>
    setOpen((prev) => {
      try {
        localStorage.setItem(ACCOUNTS_PANEL_KEY, prev ? 'closed' : 'open')
      } catch {
        // Storage blocked — the toggle still works for this session.
      }
      return !prev
    })
  return (
    <section aria-label="Accounts panel" className="relative -my-4 hidden shrink-0 border-r border-border bg-card xl:block">
      <button
        type="button"
        onClick={toggle}
        aria-label={open ? 'Collapse accounts panel' : 'Expand accounts panel'}
        aria-expanded={open}
        className="absolute -right-3 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground"
      >
        {open ? <ChevronLeft className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
      </button>
      {open ? (
        <div className="sticky top-[72px] max-h-[calc(100vh-72px)] w-[300px] overflow-y-auto py-2">
          <AccountsOverview compact variant="panel" />
        </div>
      ) : (
        <div className="w-2" />
      )}
    </section>
  )
}

export default function AllTransactionsPage() {
  const [month, setMonth] = useState(() => new Date())
  const [monthsShown, setMonthsShown] = useState(12)
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab =
    tabParam === 'transfers' || tabParam === 'spending' || tabParam === 'income' ? tabParam : 'transactions'
  function setTab(next: string) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next === 'transfers' || next === 'spending' || next === 'income') p.set('tab', next)
        else p.delete('tab')
        return p
      },
      { replace: true },
    )
  }
  // Simplifi-style date-range presets alongside the month chips: a preset
  // switches the list to a range fetch (month chips + month sidebar hide,
  // exactly like search mode). 'month' = the chip-driven single-month view.
  type RangePreset = 'month' | 'last-3' | 'last-6' | 'last-12' | 'all-time'
  const [rangePreset, setRangePreset] = useState<RangePreset>('month')
  const inRangeMode = rangePreset !== 'month'
  const rangeBounds = useMemo(() => {
    const now = new Date()
    const end = toISODate(now)
    const firstOf = (yy: number, mm: number) => toISODate(new Date(yy, mm, 1))
    switch (rangePreset) {
      case 'last-3':
        return { start: firstOf(now.getFullYear(), now.getMonth() - 2), end }
      case 'last-6':
        return { start: firstOf(now.getFullYear(), now.getMonth() - 5), end }
      case 'last-12':
        return { start: firstOf(now.getFullYear(), now.getMonth() - 11), end }
      case 'all-time':
        return { start: '2000-01-01', end }
      default:
        return { start: '', end: '' }
    }
  }, [rangePreset])
  const rangeQuery = useTransactionsRange(rangeBounds.start, rangeBounds.end, {
    enabled: inRangeMode,
  })

  // Simplifi quick filters + sort + bulk selection + column visibility.
  type QuickFilter = 'none' | 'uncategorized' | 'unreviewed'
  // Seedable via ?quick= so the Dashboard review widget can deep-link here.
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(() => {
    const q = searchParams.get('quick')
    return q === 'uncategorized' || q === 'unreviewed' ? q : 'none'
  })
  const [sortKey, setSortKey] = useState<RegisterSort>('date-desc')
  const [selectedIds, setSelectedIds] = useState<Set<UUID>>(new Set())
  const [columns, setColumnsState] = useState<RegisterColumns>(() => {
    const base: RegisterColumns = { account: true, reviewed: true, category: true, tags: false, exclusion: false }
    try {
      const raw = localStorage.getItem(COLUMNS_KEY)
      return raw ? { ...base, ...(JSON.parse(raw) as Partial<RegisterColumns>) } : base
    } catch {
      return base
    }
  })
  const setColumns = (c: RegisterColumns) => {
    setColumnsState(c)
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(c))
    } catch {
      // Storage blocked — the choice still applies this session.
    }
  }
  const [searchOpen, setSearchOpen] = useState(() => !!searchParams.get('q'))
  const [createOpen, setCreateOpen] = useState(false)
  const setReviewed = useSetReviewed()
  const bulkSetCategoryByIds = useBulkSetCategoryByIds()

  // /add-transaction deep-links here with ?tab=add-transaction: open the
  // create dialog once, then clean the param so a refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get('tab') === 'add-transaction') {
      setCreateOpen(true)
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          p.delete('tab')
          return p
        },
        { replace: true },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Include excluded/transfer rows so linked transfers stay visible + unlinkable; they're
  // kept out of the Spent/Income totals below.
  const monthQuery = useTransactionsMonthAll(month)
  const { data: txns = [], isLoading } = monthQuery
  const { data: uncategorized = [] } = useUncategorized(month)
  const { data: categories = [] } = useCategories()
  const { data: accountsList = [] } = useAccounts()
  const setCategory = useSetCategory()
  const bulkCategorize = useBulkCategorizeMerchant()
  // Best-effort: before the attachments migration runs this simply has no data.
  const { data: attachmentCounts } = useQuery({
    queryKey: ['sb', 'attachmentCounts'],
    queryFn: () => fetchAttachmentCounts().catch(() => new Map<UUID, number>()),
    retry: false,
  })

  // Build an id→Account map for the row-level account label.
  const accountsById = useMemo(
    () => new Map(accountsList.map((a) => [a.id, a])),
    [accountsList],
  )

  const [selected, setSelected] = useState<Transaction | null>(null)
  const [bulkPrompt, setBulkPrompt] = useState<BulkPrompt | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)
  const qc = useQueryClient()

  /** On-demand AI categorization: classifies whatever rules/memory couldn't.
   *  Best-effort — a backend hiccup toasts instead of breaking the page. */
  async function runAutoCategorize() {
    setAutoRunning(true)
    try {
      const stats = await autoCategorize()
      if (!stats) {
        toast.error('Could not reach the backend')
        return
      }
      if (stats.status === 'disabled') toast('AI categorization is disabled')
      else if (stats.status === 'misconfigured')
        toast.error('AI provider misconfigured — check the backend API key')
      else {
        await qc.invalidateQueries({ queryKey: ['sb'] })
        toast.success(
          `Checked ${stats.checked}: ${stats.rules_applied} by rules, ` +
            `${stats.from_cache} cached, ${stats.ai_applied} by AI, ` +
            `${stats.needs_review} need review`,
        )
      }
    } catch {
      toast.error('Auto-categorization failed')
    } finally {
      setAutoRunning(false)
    }
  }
  const [filterIds, setFilterIds] = useState<Set<UUID>>(new Set())
  const [hiddenOnly, setHiddenOnly] = useState(false)
  /** null = all; otherwise only transactions with that Need/Want tag. */
  const [needWantFilter, setNeedWantFilter] = useState<NeedWant | null>(null)
  /** null = all; otherwise only transactions with that Fixed/Variable tag. */
  const [spendPatternFilter, setSpendPatternFilter] = useState<SpendPattern | null>(null)

  // Search spans all months (server-side, search_transactions RPC). While a query is
  // active the list operates on the results instead of the month, and the month chips +
  // month-scoped sidebar hide (results are capped at the newest 50 matches).
  // Seedable via ?q= so other pages (e.g. credit auto-detection) can deep-link here.
  const [searchText, setSearchText] = useState(() => searchParams.get('q') ?? '')
  const debouncedQuery = useDebouncedValue(searchText)
  const searching = searchText.trim().length > 0
  const parsedQuery = useMemo(() => parseQuery(debouncedQuery), [debouncedQuery])
  const dslSearch = parsedQuery.constraints.length > 0
  const dslWindow = useMemo(() => {
    const today = toISODate(new Date())
    const w = dateWindow(parsedQuery)
    const lo = w && w[0] > '2000-01-01' ? w[0] : '2000-01-01'
    const hi = w && w[1] < today ? w[1] : today
    return { start: lo, end: hi }
  }, [parsedQuery])
  const dslQuery = useTransactionsRange(dslWindow.start, dslWindow.end, { enabled: dslSearch })
  const search = useTransactionSearch(dslSearch ? '' : debouncedQuery)
  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const dslResults = useMemo(
    () =>
      dslSearch
        ? (dslQuery.data ?? []).filter((t) => matchesQuery(t, parsedQuery, { accountsById, categoriesById }))
        : [],
    [dslSearch, dslQuery.data, parsedQuery, accountsById, categoriesById],
  )
  const textQuery = dslSearch ? dslQuery : search
  const activeTxns = useMemo(
    () =>
      searching
        ? dslSearch
          ? dslResults
          : (search.data ?? [])
        : inRangeMode
          ? (rangeQuery.data ?? [])
          : txns,
    [searching, dslSearch, dslResults, search.data, inRangeMode, rangeQuery.data, txns],
  )
  const activeLoading = searching ? textQuery.isPending : inRangeMode ? rangeQuery.isPending : isLoading
  const activeError = searching ? textQuery.isError : inRangeMode ? rangeQuery.isError : monthQuery.isError
  const retryActive = () =>
    void (searching ? textQuery.refetch() : inRangeMode ? rangeQuery.refetch() : monthQuery.refetch())

  // Totals ignore excluded rows (transfers, manually excluded) — they net out, not spend/income.
  // Always month-scoped (the sidebar hides while searching, so no undercount is shown).
  // Memoized so the sidebar keeps a stable `counted` identity across renders.
  const { counted, spent, income } = useMemo(() => {
    const counted = txns.filter((t) => !t.exclude_from_totals)
    // Net spend + income exclude reimbursements (contra-expense).
    return { counted, spent: sumNetSpend(counted), income: sumIncome(counted) }
  }, [txns])

  const filterCount =
    filterIds.size + (hiddenOnly ? 1 : 0) + (needWantFilter ? 1 : 0) + (spendPatternFilter ? 1 : 0)

  // The search RPC caps its result at SEARCH_LIMIT rows, and the category/tag filters
  // below run over only that set — so a capped result filters an incomplete list. Flag
  // it (raw pre-filter count) so the truncation isn't silent.
  const searchTruncated = searching && !dslSearch && (search.data?.length ?? 0) >= SEARCH_LIMIT

  // Text matching is server-side; here we only apply the category/hidden/quick
  // filters over the active set (month rows, range rows, or search results),
  // then the chosen sort. Default order is the fetch order (date desc).
  const filtered = useMemo(() => {
    const rows = activeTxns.filter((t) => {
      if (hiddenOnly && !t.hidden) return false
      if (filterIds.size > 0 && !(t.category_id && filterIds.has(t.category_id))) return false
      if (needWantFilter && t.need_want !== needWantFilter) return false
      if (spendPatternFilter && t.spend_pattern !== spendPatternFilter) return false
      if (quickFilter === 'uncategorized' && t.category_id != null) return false
      if (quickFilter === 'unreviewed' && t.reviewed) return false
      return true
    })
    switch (sortKey) {
      case 'date-asc':
        return [...rows].reverse()
      case 'amount-desc':
        return [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      case 'amount-asc':
        return [...rows].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount))
      case 'payee':
        return [...rows].sort((a, b) => displayName(a).localeCompare(displayName(b)))
      default:
        return rows
    }
  }, [activeTxns, filterIds, hiddenOnly, needWantFilter, spendPatternFilter, quickFilter, sortKey])

  const selectedTxns = useMemo(
    () => filtered.filter((t) => selectedIds.has(t.id)),
    [filtered, selectedIds],
  )
  const selectedTotal = useMemo(
    () => selectedTxns.reduce((s, t) => s - t.amount, 0),
    [selectedTxns],
  )

  function toggleSelect(t: Transaction) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(t.id)) next.delete(t.id)
      else next.add(t.id)
      return next
    })
  }

  // Month filter chips — most recent first, extendable via the "Earlier" button.
  const monthOptions = useMemo(() => {
    const now = new Date()
    const list = Array.from(
      { length: monthsShown },
      (_, i) => new Date(now.getFullYear(), now.getMonth() - i, 1),
    )
    // Keep the selected month visible even if it's outside the shown window.
    if (!list.some((m) => sameMonth(m, month))) list.push(month)
    return list
  }, [monthsShown, month])

  /** Explicit categorization; when the merchant has more uncategorized txns, offer to
   *  bulk-apply — mirrors iOS TransactionsViewModel.updateCategory(offerBulk:). */
  async function pickCategory(txn: Transaction, categoryId: UUID | null) {
    await setCategory.mutateAsync({ txn, categoryId })
    const key = merchantKey(txn)
    if (!categoryId || !key) return
    const others = await uncategorizedSameMerchant(key, txn.id).catch(() => [])
    if (others.length > 0) {
      setBulkPrompt({
        merchantName: displayName(txn),
        merchantKey: key,
        categoryId,
        count: others.length,
      })
    }
  }

  /** Export the currently-shown transactions (month or search results, after filters) to CSV. */
  function exportCsv() {
    if (filtered.length === 0) return
    const stamp = searching
      ? 'search'
      : `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`
    downloadCsv(`transactions-${stamp}.csv`, transactionsToCsv(filtered, accountsById))
  }

  const monthValue = (d: Date) => `m:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const RANGE_LABELS: Record<RangePreset, string> = {
    month: formatMonthLabel(month),
    'last-3': 'Last 3 months',
    'last-6': 'Last 6 months',
    'last-12': 'Last 12 months',
    'all-time': 'All time',
  }
  const rangeLabel = searching ? 'Search results' : RANGE_LABELS[rangePreset]
  function pickDate(v: string) {
    if (v.startsWith('m:')) {
      const [y, m] = v.slice(2).split('-').map(Number)
      setMonth(new Date(y, m - 1, 1))
      setRangePreset('month')
    } else setRangePreset(v as RangePreset)
  }
  const quickChip = (active: boolean) =>
    cn(
      'rounded-md border px-3 py-1 text-sm transition-colors',
      active ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border bg-card text-foreground hover:bg-surface-container-high',
    )

  return (
    <div className="flex gap-6 pt-2 md:pt-4">
      <AccountsPanel />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <h1 className="text-2xl font-semibold text-foreground md:text-[1.75rem]">Transactions</h1>

        <Tabs value={tab} onValueChange={setTab}>
          <UnderlineTabs
            ariaLabel="Transaction views"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'transactions', label: 'All' },
              { value: 'spending', label: 'Spending' },
              { value: 'income', label: 'Income' },
              { value: 'transfers', label: 'Transfers' },
            ]}
          />

          <TabsContent value="transactions" className="mt-4 flex flex-col gap-4">
            <AllAccountsCard />
            {!searching && !inRangeMode && <MonthSummaryCard month={month} spent={spent} income={income} counted={counted} />}
            <RemindersCard />

            <section className="card-surface p-4 md:p-5">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-foreground">Transactions</h2>
                <span className="text-sm text-muted-foreground underline decoration-dotted underline-offset-4">{rangeLabel}</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <ToolbarButton
                    icon={SearchIcon}
                    aria-label={searchOpen ? 'Hide search' : 'Show search'}
                    aria-pressed={searchOpen}
                    onClick={() => setSearchOpen((o) => !o)}
                  />
                  <ToolbarMenu icon={CalendarDays} label="Date" ariaLabel="Date range">
                    <DropdownMenuRadioGroup value={inRangeMode ? rangePreset : monthValue(month)} onValueChange={pickDate}>
                      <DropdownMenuLabel>Range</DropdownMenuLabel>
                      <DropdownMenuRadioItem value="last-3">Last 3 months</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="last-6">Last 6 months</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="last-12">Last 12 months</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="all-time">All time</DropdownMenuRadioItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Month</DropdownMenuLabel>
                      {monthOptions.map((m) => (
                        <DropdownMenuRadioItem key={monthValue(m)} value={monthValue(m)}>
                          {chipMonthLabel(m)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault()
                        setMonthsShown((n) => n + 12)
                      }}
                    >
                      <ChevronLeft aria-hidden className="mr-1 h-4 w-4" /> Earlier months
                    </DropdownMenuItem>
                  </ToolbarMenu>
                  <ToolbarMenu
                    icon={Filter}
                    label={filterCount > 0 ? `Filter (${filterCount})` : 'Filter'}
                    ariaLabel={filterCount > 0 ? `Filters, ${filterCount} active` : 'Filters'}
                    contentClassName="w-60"
                  >
                    <DropdownMenuLabel>Show</DropdownMenuLabel>
                    <DropdownMenuCheckboxItem checked={hiddenOnly} onCheckedChange={setHiddenOnly} onSelect={(e) => e.preventDefault()}>
                      Hidden only
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Need / Want</DropdownMenuLabel>
                    {(['need', 'want'] as NeedWant[]).map((v) => (
                      <DropdownMenuCheckboxItem
                        key={v}
                        checked={needWantFilter === v}
                        onCheckedChange={() => setNeedWantFilter((cur) => (cur === v ? null : v))}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {v === 'need' ? 'Need' : 'Want'}
                      </DropdownMenuCheckboxItem>
                    ))}
                    <DropdownMenuLabel>Fixed / Variable</DropdownMenuLabel>
                    {(['fixed', 'variable'] as SpendPattern[]).map((v) => (
                      <DropdownMenuCheckboxItem
                        key={v}
                        checked={spendPatternFilter === v}
                        onCheckedChange={() => setSpendPatternFilter((cur) => (cur === v ? null : v))}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {v === 'fixed' ? 'Fixed' : 'Variable'}
                      </DropdownMenuCheckboxItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Categories{filterIds.size > 0 ? ` (${filterIds.size})` : ''}</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-80 w-60 overflow-y-auto">
                        {hierarchical(categories).map(({ c, label }) => (
                          <DropdownMenuCheckboxItem
                            key={c.id}
                            checked={filterIds.has(c.id)}
                            onSelect={(e) => e.preventDefault()}
                            onCheckedChange={(v) =>
                              setFilterIds((prev) => {
                                const next = new Set(prev)
                                if (v) next.add(c.id)
                                else next.delete(c.id)
                                return next
                              })
                            }
                          >
                            {label}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </ToolbarMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <ToolbarButton icon={MoreVertical} aria-label="More actions" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      <DropdownMenuItem disabled={autoRunning} onSelect={() => void runAutoCategorize()}>
                        <WandSparkles className="mr-2 h-4 w-4" aria-hidden />
                        {autoRunning ? 'Categorizing…' : 'Auto-categorize'}
                      </DropdownMenuItem>
                      {uncategorized.length > 0 && (
                        <DropdownMenuItem onSelect={() => setReviewOpen(true)}>
                          <WandSparkles className="mr-2 h-4 w-4" aria-hidden />
                          Review {uncategorized.length} to categorize
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                        <Upload className="mr-2 h-4 w-4" aria-hidden /> Import CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={filtered.length === 0} onSelect={exportCsv}>
                        <Download className="mr-2 h-4 w-4" aria-hidden /> Export CSV
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    New
                  </button>
                </div>
              </div>

              {searchOpen && <TransactionSearchBox value={searchText} onChange={setSearchText} className="mt-3" />}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Quick filters</span>
                <button
                  type="button"
                  onClick={() => {
                    setRangePreset('month')
                    setMonth(new Date())
                    setSearchText('')
                  }}
                  aria-pressed={rangePreset === 'month' && sameMonth(month, new Date()) && !searching}
                  className={quickChip(rangePreset === 'month' && sameMonth(month, new Date()) && !searching)}
                >
                  This month
                </button>
                <button
                  type="button"
                  onClick={() => setQuickFilter((cur) => (cur === 'uncategorized' ? 'none' : 'uncategorized'))}
                  aria-pressed={quickFilter === 'uncategorized'}
                  className={quickChip(quickFilter === 'uncategorized')}
                >
                  Uncategorized
                </button>
                <button
                  type="button"
                  onClick={() => setQuickFilter((cur) => (cur === 'unreviewed' ? 'none' : 'unreviewed'))}
                  aria-pressed={quickFilter === 'unreviewed'}
                  className={quickChip(quickFilter === 'unreviewed')}
                >
                  Unreviewed
                </button>
                {uncategorized.length > 0 && (
                  <button type="button" onClick={() => setReviewOpen(true)} className="ml-auto text-sm font-medium text-primary hover:underline">
                    {uncategorized.length} to categorize · Review
                  </button>
                )}
              </div>

              {selectedIds.size > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-primary/5 p-2">
                  <span className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground tabular-nums">
                    {selectedIds.size} selected · {formatCurrency(selectedTotal)}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <ToolbarButton label="Categorize" caret />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-96 w-52 overflow-y-auto">
                      <DropdownMenuLabel>Set category</DropdownMenuLabel>
                      <DropdownMenuItem
                        onSelect={() => {
                          bulkSetCategoryByIds.mutate({ ids: [...selectedIds], categoryId: null })
                          setSelectedIds(new Set())
                        }}
                      >
                        Uncategorized
                      </DropdownMenuItem>
                      {hierarchical(categories).map(({ c, label }) => (
                        <DropdownMenuItem
                          key={c.id}
                          onSelect={() => {
                            bulkSetCategoryByIds.mutate({ ids: [...selectedIds], categoryId: c.id })
                            setSelectedIds(new Set())
                          }}
                        >
                          {label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <ToolbarButton
                    label="Mark as reviewed"
                    onClick={() => {
                      setReviewed.mutate({ ids: [...selectedIds], reviewed: true })
                      setSelectedIds(new Set())
                    }}
                  />
                  <ToolbarButton
                    label="Mark as unreviewed"
                    onClick={() => {
                      setReviewed.mutate({ ids: [...selectedIds], reviewed: false })
                      setSelectedIds(new Set())
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    aria-label="Clear selection"
                    className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
              )}

              {searchTruncated && !activeLoading && !activeError && (
                <p className="mt-3 rounded-lg bg-surface-container-low px-3 py-2 text-xs text-muted-foreground">
                  Showing the first {SEARCH_LIMIT} matches — refine your search to narrow it, as filters apply only to the results shown.
                </p>
              )}

              <div className="mt-4">
                {activeLoading ? (
                  <p className="px-1 text-sm text-muted-foreground">{searching ? 'Searching…' : 'Loading…'}</p>
                ) : activeError ? (
                  <ErrorState onRetry={retryActive} error={searching ? textQuery.error : monthQuery.error} />
                ) : filtered.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-outline-variant p-8 text-center text-sm text-muted-foreground">
                    {searching
                      ? `No matches for “${searchText.trim()}”.`
                      : activeTxns.length === 0
                        ? inRangeMode
                          ? 'No transactions in this range.'
                          : 'No transactions this month.'
                        : 'No transactions match your filters.'}
                  </div>
                ) : (
                  <TransactionTable
                    transactions={filtered}
                    accountsById={accountsById}
                    onSelect={setSelected}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    onSetSelection={setSelectedIds}
                    onToggleReviewed={(t) => setReviewed.mutate({ ids: [t.id], reviewed: !t.reviewed })}
                    columns={columns}
                    onColumnsChange={setColumns}
                    sort={sortKey}
                    onSortChange={setSortKey}
                    renderTags={(t) => <TransactionTagControls txn={t} className="" />}
                    attachmentCounts={attachmentCounts}
                    grouped={sortKey === 'date-desc' || sortKey === 'date-asc'}
                  />
                )}
              </div>
            </section>
          </TabsContent>

          {(['spending', 'income'] as const).map((v) => (
            <TabsContent key={v} value={v} className="mt-4 flex flex-col gap-4">
              {tab === v && (
                <>
                  <AllAccountsCard />
                  <FlowAnalysisTab
                    flow={v === 'spending' ? 'spend' : 'income'}
                    accountsById={accountsById}
                    categoriesById={categoriesById}
                    onSelect={setSelected}
                    onToggleReviewed={(t) => setReviewed.mutate({ ids: [t.id], reviewed: !t.reviewed })}
                  />
                </>
              )}
            </TabsContent>
          ))}

          <TabsContent value="transfers" className="mt-4">
            <TransfersTab month={month} />
          </TabsContent>
        </Tabs>
      </div>

      <CreateTransactionDialog open={createOpen} onOpenChange={setCreateOpen} accounts={accountsList} categories={categories} />

      <CategoryPickerDialog
        txn={selected}
        open={selected != null}
        onOpenChange={(o) => !o && setSelected(null)}
        onPick={(cid) => {
          if (selected) void pickCategory(selected, cid)
          setSelected(null)
        }}
      />

      <BulkCategorizePrompt
        prompt={bulkPrompt}
        onApply={(p) => {
          bulkCategorize.mutate({ merchantKey: p.merchantKey, categoryId: p.categoryId })
          setBulkPrompt(null)
        }}
        onDismiss={() => setBulkPrompt(null)}
      />

      {reviewOpen && <CategorizeReview queue={uncategorized} open={reviewOpen} onOpenChange={setReviewOpen} />}

      <CsvImportDialog open={importOpen} accounts={accountsList} onOpenChange={setImportOpen} />
    </div>
  )
}
