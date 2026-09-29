// Watched spending plan — per-category planned-vs-actual cards for the user's
// watched categories (Settings → Watched categories; defaults Shopping,
// Eating Out, Groceries). Neutral numbers only: remaining/overspent facts,
// a progress bar, and "spent X of Y" — no dollars-per-day, no pace judgments.
// Planned amounts come from the same month-budget targets the Budgets tab
// edits; actuals come from month-to-date spend.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ProgressBar } from '@/components/finance/ProgressBar'
import {
  useCategories,
  useMonthBudgets,
  useMyProfile,
  useSpendByCategory,
} from '@/data/hooks'
import { buildBudgetRows } from '@/lib/budgetTotals'
import { toISODate } from '@/lib/dates'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'

/** Defaults when the profile has no saved watched categories (names, lowercase). */
const WATCHED_DEFAULT_NAMES = ['shopping', 'eating out', 'groceries']

function monthLabel(today: Date) {
  return today.toLocaleString(undefined, { month: 'long', year: 'numeric' })
}

export default function WatchedSpendingPlan() {
  const today = useMemo(() => new Date(), [])
  const monthFirst = toISODate(new Date(today.getFullYear(), today.getMonth(), 1))

  const { data: profile } = useMyProfile()
  const { data: categories = [] } = useCategories()
  const { data: budgets = [] } = useMonthBudgets(monthFirst)
  const { data: spendRows = [] } = useSpendByCategory(today)

  const watchedIds = useMemo(() => {
    const active = categories.filter((c) => c.is_active !== false)
    if (profile?.watched_categories && profile.watched_categories.length > 0) {
      const saved = new Set(profile.watched_categories)
      return active.filter((c) => saved.has(c.id)).map((c) => c.id)
    }
    const byName = new Map(active.map((c) => [c.name.trim().toLowerCase(), c.id]))
    return WATCHED_DEFAULT_NAMES.map((n) => byName.get(n)).filter(
      (id): id is string => !!id,
    )
  }, [profile?.watched_categories, categories])

  const rows = useMemo(() => {
    const all = buildBudgetRows(
      categories,
      budgets,
      spendRows.map((s) => ({ categoryId: s.category.id, total: s.total })),
    )
    const wanted = new Set(watchedIds)
    return all.filter((r) => r.categoryId != null && wanted.has(r.categoryId))
  }, [categories, budgets, spendRows, watchedIds])

  return (
    <section className="card-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-medium leading-7 text-foreground">
          Spending plan · {monthLabel(today)}
        </h2>
        <Link to="/budgets" className="text-sm font-semibold text-primary hover:underline">
          View all
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No watched categories yet.{' '}
          <Link to="/budgets" className="font-semibold text-primary hover:underline">
            Set a budget
          </Link>{' '}
          or pick watched categories in Settings.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {rows.map((r) => (
            <div
              key={r.categoryId}
              className="rounded-xl border border-border bg-surface-container-low p-4"
            >
              <p className="truncate text-sm font-semibold text-foreground">{r.category}</p>
              {r.target > 0 ? (
                <p
                  className={cn(
                    'mt-1 text-lg font-bold tabular-nums',
                    r.overBudget ? 'text-destructive' : 'text-money-income',
                  )}
                >
                  {r.overBudget
                    ? `${formatCurrency(-r.remaining)} overspent`
                    : `${formatCurrency(r.remaining)} available`}
                </p>
              ) : (
                <p className="mt-1 text-lg font-bold tabular-nums text-foreground">
                  {formatCurrency(r.actual)} spent
                </p>
              )}
              <div className="mt-2">
                <ProgressBar
                  value={Math.min(100, r.fraction * 100)}
                  fillClassName={r.overBudget ? 'bg-destructive' : 'bg-primary'}
                  label={`${r.category} budget progress`}
                />
              </div>
              <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">
                {r.target > 0
                  ? `Spent ${formatCurrency(r.actual)} of ${formatCurrency(r.target)}`
                  : `Spent ${formatCurrency(r.actual)} · no budget set`}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
