// Top Spending Categories — Simplifi-style dashboard widget: this month's
// biggest categories with amounts and a share bar, from the category_spend
// view (the same source the Transactions sidebar uses).

import { createElement, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ProgressBar } from '@/components/finance/ProgressBar'
import { useSpendByCategory } from '@/data/hooks'
import { iconForSymbol } from '@/lib/iconMap'
import { categorySeriesColor, categoryTint } from '@/lib/categoryColors'
import { formatCurrency } from '@/lib/money'

export default function TopCategories() {
  const today = useMemo(() => new Date(), [])
  const { data: spendRows = [] } = useSpendByCategory(today)

  const top = useMemo(() => spendRows.filter((r) => r.total > 0).slice(0, 5), [spendRows])
  const monthTotal = useMemo(
    () => spendRows.reduce((s, r) => s + Math.max(0, r.total), 0),
    [spendRows],
  )
  const monthLabel = today.toLocaleDateString(undefined, { month: 'long' })

  return (
    <section className="card-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-medium leading-7 text-foreground">
          Top categories · {monthLabel}
        </h2>
        <Link to="/reports" className="text-sm font-semibold text-primary hover:underline">
          Reports
        </Link>
      </div>
      {top.length === 0 ? (
        <p className="text-sm text-muted-foreground">No spending yet this month.</p>
      ) : (
        <ul className="space-y-4">
          {top.map(({ category, total }) => {
            const pct = monthTotal > 0 ? Math.round((total / monthTotal) * 100) : 0
            return (
              <li key={category.id} className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  style={{
                    backgroundColor: categoryTint(category.color),
                    color: categorySeriesColor(category),
                  }}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                >
                  {createElement(iconForSymbol(category.icon), { className: 'h-4 w-4' })}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {category.name}
                    </span>
                    <span className="text-sm font-medium tabular-nums text-foreground">
                      {formatCurrency(total)}
                    </span>
                  </div>
                  <ProgressBar value={pct} trackClassName="bg-surface-container-low" />
                  <span className="mt-1 text-xs font-semibold text-muted-foreground">
                    {pct}% of this month's spending
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
