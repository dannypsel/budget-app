// Review Transactions — Simplifi-style dashboard review widget: cards for the
// queues that need eyeballs (unreviewed in the last 30 days, uncategorized
// this month, large amounts), each with a count and a signed total, linking
// into the Transactions tab with the matching quick filter preselected.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTransactionsMonth, useTransactionsRange } from '@/data/hooks'
import { toISODate } from '@/lib/dates'
import { formatCurrency } from '@/lib/money'

const LARGE_THRESHOLD = 1000

export default function ReviewTransactions() {
  const today = useMemo(() => new Date(), [])
  const start30 = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 29)
    return toISODate(d)
  }, [])
  const { data: last30 = [] } = useTransactionsRange(start30, toISODate(today))
  const { data: monthTxns = [] } = useTransactionsMonth(today)

  const cards = useMemo(() => {
    const unreviewed = last30.filter((t) => !t.reviewed)
    const uncategorized = monthTxns.filter((t) => t.category_id == null && !t.exclude_from_totals)
    const large = last30.filter((t) => Math.abs(t.amount) >= LARGE_THRESHOLD)
    // Signed net in PocketLens display convention: spend shows negative.
    const net = (rows: typeof last30) => -rows.reduce((s, t) => s + t.amount, 0)
    return [
      {
        key: 'unreviewed',
        title: 'Unreviewed · last 30 days',
        count: unreviewed.length,
        total: net(unreviewed),
        to: '/transactions?quick=unreviewed',
      },
      {
        key: 'uncategorized',
        title: 'Uncategorized · this month',
        count: uncategorized.length,
        total: net(uncategorized),
        to: '/transactions?quick=uncategorized',
      },
      {
        key: 'large',
        title: `Large amounts ($${LARGE_THRESHOLD.toLocaleString()}+) · last 30 days`,
        count: large.length,
        total: net(large),
        to: '/transactions',
      },
    ]
  }, [last30, monthTxns])

  return (
    <section className="card-surface p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-medium leading-7 text-foreground">Review transactions</h2>
        <Link to="/transactions" className="text-sm font-semibold text-primary hover:underline">
          Review all
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {cards.map((c) => (
          <li key={c.key}>
            <Link
              to={c.to}
              className="flex items-center gap-3 py-3 transition-colors hover:bg-accent rounded-lg px-1 -mx-1"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{c.title}</p>
                <p className="text-xs text-muted-foreground">
                  {c.count} transaction{c.count === 1 ? '' : 's'} to review
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                {formatCurrency(c.total)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
