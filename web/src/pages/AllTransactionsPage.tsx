// Transactions — terracotta/sage layout: search + month filter chips up top, day-grouped
// list in the main column, and (desktop) a right sidebar with the monthly spending summary
// and Top Category cards derived from the already-fetched month of transactions.
// Plain-text search is server-side across all months (search_transactions RPC); a query with
// Simplifi search syntax (payee:, date=, amount>, is:reviewed …, lib/searchDsl) fetches the
// date window it implies and matches client-side. While a query is active the month chips and
// the month-scoped sidebar hide.
// Keeps the Transfers tab (?tab=transfers) and the "To Categorize" swipe review.
// Mirrors PocketLens/Views/Transactions/TransactionsView.swift.

import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchAttachmentCounts } from '@/data/txnExtras'
import { toast } from 'sonner'
import { ArrowUpRight, ChevronLeft, ChevronRight, Columns3, Download, Filter, Plus, RotateCcw, Upload, WandSparkles, X } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TransactionList } from '@/features/transactions/TransactionList'
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
  useCategories,
  useRecurringSeries,
  useSetCategory,
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

const filterChip = (active: boolean) =>
  cn(
    'whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-95',
    active
      ? 'bg-primary text-primary-foreground shadow-sm'
      : 'border border-border bg-card text-muted-foreground hover:bg-surface-container-high',
  )

/** Sidebar: monthly spending summary + Top Category + Recurring Charges, derived from the fetched month. */
function TransactionsSidebar({
  month,
  spent,
  income,
  counted,
}: {
  month: Date
  spent: number
  income: number
  counted: Transaction[]
}) {
  const { data: spendRows = [] } = useSpendByCategory(month)
  const { data: recurringSeries = [], isLoading: recurringLoading } = useRecurringSeries()

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

  // Biggest spend category this month, from the category_spend view (rows arrive
  // sorted by spend desc). Over-reimbursed categories can go negative, so guard > 0.
  const top = useMemo(() => {
    const best = spendRows[0]
    return best && best.total > 0 ? { category: best.category, amount: best.total } : null
  }, [spendRows])

  // Recurring summary — active (non-ignored) series + monthly estimate.
  const activeRecurring = useMemo(
    () => recurringSeries.filter((s) => s.status !== 'ignored'),
    [recurringSeries],
  )
  const PER_MONTH_FACTORS: Record<string, number> = {
    weekly: 52 / 12,
    biweekly: 26 / 12,
    monthly: 1,
    yearly: 1 / 12,
  }
  const recurringMonthly = useMemo(
    () =>
      activeRecurring.reduce(
        (sum, s) => sum + Math.abs(s.avgAmount) * (PER_MONTH_FACTORS[s.cadence] ?? 1),
        0,
      ),
    [activeRecurring],
  )

  const monthShort = month.toLocaleDateString(undefined, { month: 'short' })
  const topPct = top && spent > 0 ? Math.round((top.amount / spent) * 100) : 0

  return (
    <aside className="flex w-full shrink-0 flex-col gap-6 lg:w-[360px]">
      <div className="flex flex-col gap-4 card-surface p-6">
        <div>
          {/* Wording keeps "Spent" on the page — e2e smoke asserts getByText('Spent') */}
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Spent in {formatMonthLabel(month)}
          </h3>
          <CountUp
            value={spent}
            format={(n) => formatCurrency(n)}
            className="mt-1 block text-4xl font-bold tracking-tight tabular-nums text-foreground"
          />
          {/* Always rendered (even $0) — the month's Income total shouldn't
              vanish, and e2e smoke asserts getByText('Income'). */}
          <p className="mt-3 flex items-center gap-1 text-sm">
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-secondary" />
            <span className="font-medium text-muted-foreground">Income</span>
            <span className="ml-auto font-semibold tabular-nums text-secondary">
              +{formatCurrency(income)}
            </span>
          </p>
        </div>
        <div>
          <div
            aria-hidden="true"
            className="relative flex h-16 w-full items-end gap-px border-b border-border"
          >
            {daily.map((v, i) => (
              <div
                key={i}
                className={cn(
                  'flex-1 rounded-t-sm',
                  i === maxDay && v > 0 ? 'bg-primary' : 'bg-surface-variant',
                )}
                style={{ height: `${Math.max((v / maxSpend) * 100, 3)}%` }}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs font-semibold text-muted-foreground opacity-70">
            <span>{monthShort} 1</span>
            <span>{monthShort} 15</span>
            <span>
              {monthShort} {daysInMonth}
            </span>
          </div>
        </div>
      </div>

      {top && (
        <div className="flex flex-col gap-4 card-surface p-6">
          <h3 className="text-xl font-medium text-foreground">Top Category</h3>
          <div className="flex items-center gap-4">
            <span
              aria-hidden="true"
              style={{
                backgroundColor: categoryTint(top.category.color),
                color: categorySeriesColor(top.category),
              }}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
            >
              {createElement(iconForSymbol(top.category.icon), { className: 'h-5 w-5' })}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-foreground">
                  {top.category.name}
                </span>
                <span className="text-sm font-medium tabular-nums text-foreground">
                  {formatCurrency(top.amount)}
                </span>
              </div>
              <ProgressBar value={topPct} trackClassName="bg-surface-container-low" />
              <span className="mt-1 text-xs font-semibold text-muted-foreground">
                {topPct}% of this month's spending
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Recurring Charges summary card */}
      {!recurringLoading && (
        <Link
          to="/recurring"
          className="group flex flex-col gap-4 card-surface p-6 transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-medium text-foreground">Recurring Charges</h3>
            <ArrowUpRight
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
            />
          </div>
          {activeRecurring.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recurring charges detected yet.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-1">
                <CountUp
                  value={recurringMonthly}
                  format={(n) => formatCurrency(n)}
                  className="text-3xl font-bold tracking-tight tabular-nums text-foreground"
                />
                <span className="text-sm font-medium text-muted-foreground">/mo</span>
              </div>
              <div className="flex flex-col gap-2">
                {activeRecurring.slice(0, 3).map((s) => (
                  <div key={s.merchantKey} className="flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {s.displayName}
                    </span>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
                      {formatCurrency(Math.abs(s.avgAmount))}
                    </span>
                  </div>
                ))}
                {activeRecurring.length > 3 && (
                  <p className="text-xs text-muted-foreground">
                    +{activeRecurring.length - 3} more
                  </p>
                )}
              </div>
            </>
          )}
        </Link>
      )}
    </aside>
  )
}

const ACCOUNTS_PANEL_KEY = 'pocketlens.txnAccountsPanel'

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
    <aside className="relative hidden shrink-0 xl:block">
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
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] w-[300px] overflow-y-auto">
          <AccountsOverview compact />
        </div>
      ) : (
        <div className="w-2" />
      )}
    </aside>
  )
}

export default function AllTransactionsPage() {
  const [month, setMonth] = useState(() => new Date())
  const [monthsShown, setMonthsShown] = useState(12)
  const chipRowRef = useRef<HTMLDivElement>(null)
  // Mouse wheel fires deltaY; browsers register wheel listeners as passive by default
  // so we must attach a native listener with { passive: false } to call preventDefault()
  // and redirect vertical scroll to horizontal on the chip row.
  useEffect(() => {
    const el = chipRowRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      e.preventDefault()
      el.scrollBy({ left: e.deltaY, behavior: 'auto' })
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab =
    tabParam === 'transfers' || tabParam === 'spending' || tabParam === 'income' ? tabParam : 'transactions'
  const analysisTab = tab === 'spending' || tab === 'income'
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
  type SortKey = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'payee'
  const [sortKey, setSortKey] = useState<SortKey>('date-desc')
  const [selectedIds, setSelectedIds] = useState<Set<UUID>>(new Set())
  const [showAccountCol, setShowAccountCol] = useState(true)
  const [showCategoryCol, setShowCategoryCol] = useState(true)
  const [showTagsCol, setShowTagsCol] = useState(true)
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

  return (
    <div className="flex flex-col gap-6 pt-2 md:pt-4 lg:flex-row">
      <AccountsPanel />
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-foreground md:text-[2rem] md:leading-10">
            Transactions
          </h1>
          <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">New</span>
          </button>
          <button
            type="button"
            onClick={() => void runAutoCategorize()}
            disabled={autoRunning}
            title="Classify uncategorized transactions with AI (rules and merchant memory apply first)"
            className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            <WandSparkles aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">{autoRunning ? 'Categorizing…' : 'Auto-categorize'}</span>
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">Import CSV</span>
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">Export CSV</span>
          </button>
          </div>
        </div>

        {/* Search + filters (sticky on mobile, under the 72px top app bar) */}
        <div
          className={cn(
            'sticky top-[72px] z-30 -mx-4 flex flex-col gap-3 bg-background px-4 pb-1 md:static md:z-auto md:mx-0 md:bg-transparent md:px-0 md:pb-0',
            analysisTab && 'hidden',
          )}
        >
          <div className="flex items-center gap-3">
            <TransactionSearchBox value={searchText} onChange={setSearchText} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={filterCount > 0 ? `Filters, ${filterCount} active` : 'Filters'}
                  className="flex items-center gap-2 card-surface border border-border px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Filter aria-hidden="true" className="h-4 w-4" />
                  <span className="hidden sm:inline">
                    {filterCount > 0 ? `${filterCount} filtered` : 'Filter'}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-96 w-52 overflow-y-auto">
                <DropdownMenuLabel>Show</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={hiddenOnly} onCheckedChange={setHiddenOnly}>
                  Hidden only
                </DropdownMenuCheckboxItem>
                <DropdownMenuLabel>Categories</DropdownMenuLabel>
                {categories.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={filterIds.has(c.id)}
                    onCheckedChange={(v) =>
                      setFilterIds((prev) => {
                        const next = new Set(prev)
                        if (v) next.add(c.id)
                        else next.delete(c.id)
                        return next
                      })
                    }
                  >
                    {c.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Customize columns"
                  className="flex items-center gap-2 card-surface border border-border px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Columns3 aria-hidden="true" className="h-4 w-4" />
                  <span className="hidden sm:inline">Columns</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Show in list</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={showAccountCol} onCheckedChange={setShowAccountCol}>
                  Account
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={showCategoryCol} onCheckedChange={setShowCategoryCol}>
                  Category
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={showTagsCol} onCheckedChange={setShowTagsCol}>
                  Need/Want + Fixed/Variable tags
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Quick filters + date range + sort (Simplifi toolbar) */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setRangePreset('month')
                setMonth(new Date())
                setSearchText('')
              }}
              aria-pressed={rangePreset === 'month' && sameMonth(month, new Date()) && !searching}
              className={filterChip(rangePreset === 'month' && sameMonth(month, new Date()) && !searching)}
            >
              This month
            </button>
            <button
              type="button"
              onClick={() => setQuickFilter((cur) => (cur === 'uncategorized' ? 'none' : 'uncategorized'))}
              aria-pressed={quickFilter === 'uncategorized'}
              className={filterChip(quickFilter === 'uncategorized')}
            >
              Uncategorized
            </button>
            <button
              type="button"
              onClick={() => setQuickFilter((cur) => (cur === 'unreviewed' ? 'none' : 'unreviewed'))}
              aria-pressed={quickFilter === 'unreviewed'}
              className={filterChip(quickFilter === 'unreviewed')}
            >
              Unreviewed
            </button>
            <label className="ml-2 flex items-center gap-2 text-sm text-muted-foreground">
              <span className="eyebrow">Date</span>
              <select
                aria-label="Date range"
                value={rangePreset}
                onChange={(e) => setRangePreset(e.target.value as RangePreset)}
                className="h-9 rounded-full border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="month">By month</option>
                <option value="last-3">Last 3 months</option>
                <option value="last-6">Last 6 months</option>
                <option value="last-12">Last 12 months</option>
                <option value="all-time">All time</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="eyebrow">Sort</span>
              <select
                aria-label="Sort transactions"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="h-9 rounded-full border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="date-desc">Date (newest)</option>
                <option value="date-asc">Date (oldest)</option>
                <option value="amount-desc">Amount (largest)</option>
                <option value="amount-asc">Amount (smallest)</option>
                <option value="payee">Payee (A–Z)</option>
              </select>
            </label>
          </div>

          {/* Need/Want + Fixed/Variable tag filters */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow">Need/Want</span>
            {(['need', 'want'] as NeedWant[]).map((v) => (
              <button
                key={v}
                onClick={() => setNeedWantFilter((cur) => (cur === v ? null : v))}
                aria-pressed={needWantFilter === v}
                className={filterChip(needWantFilter === v)}
              >
                {v === 'need' ? 'Need' : 'Want'}
              </button>
            ))}
            <span className="eyebrow ml-3">Fixed/Variable</span>
            {(['fixed', 'variable'] as SpendPattern[]).map((v) => (
              <button
                key={v}
                onClick={() => setSpendPatternFilter((cur) => (cur === v ? null : v))}
                aria-pressed={spendPatternFilter === v}
                className={filterChip(spendPatternFilter === v)}
              >
                {v === 'fixed' ? 'Fixed' : 'Variable'}
              </button>
            ))}
          </div>

          {/* Month chips — hidden while searching or in a date-range preset */}
          {!searching && !inRangeMode && (
            <div ref={chipRowRef} className="no-scrollbar flex gap-2 overflow-x-auto pb-1 pt-0.5">
              {monthOptions.map((m) => (
                <button
                  key={`${m.getFullYear()}-${m.getMonth()}`}
                  onClick={() => setMonth(m)}
                  aria-pressed={sameMonth(m, month)}
                  className={filterChip(sameMonth(m, month))}
                >
                  {chipMonthLabel(m)}
                </button>
              ))}
              <button
                onClick={() => setMonthsShown((n) => n + 12)}
                aria-label="Show earlier months"
                className={filterChip(false)}
              >
                <ChevronLeft aria-hidden="true" className="-ml-1 mr-1 inline h-4 w-4" />
                Earlier
              </button>
            </div>
          )}
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto w-auto justify-start gap-2 rounded-none bg-transparent p-0">
            <TabsTrigger
              value="transactions"
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Transactions
            </TabsTrigger>
            <TabsTrigger
              value="spending"
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Spending
            </TabsTrigger>
            <TabsTrigger
              value="income"
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Income
            </TabsTrigger>
            <TabsTrigger
              value="transfers"
              className="rounded-full border border-border bg-card px-4 py-2 text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Transfers
            </TabsTrigger>
          </TabsList>

          <TabsContent value="transactions" className="mt-5 space-y-5">
            {/* Bulk action bar (Simplifi selection bar) */}
            {selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-3 card-surface p-3">
                <span className="rounded-full bg-primary px-3 py-1 text-sm font-medium text-primary-foreground tabular-nums">
                  {selectedIds.size} selected · {formatCurrency(selectedTotal)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high"
                    >
                      Categorize
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-96 w-52 overflow-y-auto">
                    <DropdownMenuLabel>Set category</DropdownMenuLabel>
                    <DropdownMenuCheckboxItem
                      checked={false}
                      onCheckedChange={() => {
                        bulkSetCategoryByIds.mutate({
                          ids: [...selectedIds],
                          categoryId: null,
                        })
                        setSelectedIds(new Set())
                      }}
                    >
                      Uncategorized
                    </DropdownMenuCheckboxItem>
                    {categories.map((c) => (
                      <DropdownMenuCheckboxItem
                        key={c.id}
                        checked={false}
                        onCheckedChange={() => {
                          bulkSetCategoryByIds.mutate({
                            ids: [...selectedIds],
                            categoryId: c.id,
                          })
                          setSelectedIds(new Set())
                        }}
                      >
                        {c.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  onClick={() => {
                    setReviewed.mutate({ ids: [...selectedIds], reviewed: true })
                    setSelectedIds(new Set())
                  }}
                  className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high"
                >
                  Mark as reviewed
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReviewed.mutate({ ids: [...selectedIds], reviewed: false })
                    setSelectedIds(new Set())
                  }}
                  className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high"
                >
                  Mark as unreviewed
                </button>
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

            {/* To Categorize banner */}
            {uncategorized.length > 0 && (
              <button
                onClick={() => setReviewOpen(true)}
                className="group flex w-full items-center gap-4 card-surface p-4 text-left transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-container-low text-primary"
                >
                  <WandSparkles className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {uncategorized.length} to categorize
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Review them one at a time
                  </span>
                </span>
                <span className="rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors group-hover:bg-primary/90">
                  Review
                </span>
              </button>
            )}

            {searchTruncated && !activeLoading && !activeError && (
              <p className="rounded-lg bg-surface-container-low px-3 py-2 text-xs text-muted-foreground">
                Showing the first {SEARCH_LIMIT} matches — refine your search to narrow it, as
                filters apply only to the results shown.
              </p>
            )}

            {activeLoading ? (
              <p className="px-1 text-sm text-muted-foreground">
                {searching ? 'Searching…' : 'Loading…'}
              </p>
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
              <TransactionList
                transactions={filtered}
                accounts={showAccountCol ? accountsById : undefined}
                onSelect={setSelected}
                renderTags={showTagsCol ? (t) => <TransactionTagControls txn={t} /> : undefined}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onToggleReviewed={(t) =>
                  setReviewed.mutate({ ids: [t.id], reviewed: !t.reviewed })
                }
                showCategory={showCategoryCol}
                flat={sortKey !== 'date-desc'}
                attachmentCounts={attachmentCounts}
              />
            )}
          </TabsContent>

          {(['spending', 'income'] as const).map((v) => (
            <TabsContent key={v} value={v} className="mt-5">
              {tab === v && (
                <FlowAnalysisTab
                  flow={v === 'spending' ? 'spend' : 'income'}
                  accountsById={accountsById}
                  categoriesById={categoriesById}
                  onSelect={setSelected}
                  onToggleReviewed={(t) => setReviewed.mutate({ ids: [t.id], reviewed: !t.reviewed })}
                />
              )}
            </TabsContent>
          ))}

          <TabsContent value="transfers" className="mt-5">
            <TransfersTab month={month} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Spend summary is transactions-scoped and month-scoped — hide it on the Transfers
          tab, while searching, and in a date-range preset. */}
      {tab === 'transactions' && !searching && !inRangeMode && (
        <TransactionsSidebar month={month} spent={spent} income={income} counted={counted} />
      )}

      <CreateTransactionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accounts={accountsList}
        categories={categories}
      />

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

      {reviewOpen && (
        <CategorizeReview
          queue={uncategorized}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
        />
      )}

      <CsvImportDialog
        open={importOpen}
        accounts={accountsList}
        onOpenChange={setImportOpen}
      />
    </div>
  )
}
