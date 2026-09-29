// Recent transactions — the 10 most recent rows: payee, category, amount,
// short date. Income renders with a "+" prefix in income green; spend is plain.
// Sign convention: Transaction.amount > 0 = spend, < 0 = income.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useRecent } from '@/data/hooks'
import { displayName } from '@/types/domain'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'

function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function RecentTransactions() {
  const { data: recent = [] } = useRecent(30)
  const rows = useMemo(() => recent.slice(0, 10), [recent])

  return (
    <section className="card-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-medium leading-7 text-foreground">Recent transactions</h2>
        <Link to="/transactions" className="text-sm font-semibold text-primary hover:underline">
          See all
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recent transactions.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => {
            const income = t.amount < 0
            return (
              <li key={t.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {displayName(t)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t.categories?.name ?? 'Uncategorized'} · {shortDate(t.date)}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    income ? 'text-money-income' : 'text-foreground',
                  )}
                >
                  {income ? '+' : ''}
                  {formatCurrency(Math.abs(t.amount))}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
