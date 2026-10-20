// Churning deadlines widget — the household "use now" list, compact: the five
// nearest card deadlines (bonus spend, credit expiry, annual fee), ordered by
// nearest deadline. Full list lives in the Churning tab.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAllChurnBonuses, useAllChurnCredits, useChurnCards } from '@/data/hooks'
import { buildChurnDeadlines, daysUntil } from '@/lib/churning'
import { cn } from '@/lib/utils'

export default function ChurnDeadlinesWidget() {
  const { data: cards = [] } = useChurnCards()
  const { data: bonuses = [] } = useAllChurnBonuses()
  const { data: credits = [] } = useAllChurnCredits()
  const deadlines = useMemo(
    () => buildChurnDeadlines(cards, bonuses, credits).slice(0, 5),
    [cards, bonuses, credits],
  )

  return (
    <section className="card-surface p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-xl font-medium leading-7 text-foreground">Card deadlines</h3>
        <Link to="/churning" className="text-sm font-semibold text-primary hover:underline">
          View all
        </Link>
      </div>
      {deadlines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No upcoming card deadlines.{' '}
          <Link to="/churning" className="font-semibold text-primary hover:underline">
            Track a card
          </Link>{' '}
          to see bonus and fee deadlines here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {deadlines.map((d, i) => {
            const left = daysUntil(d.date)
            return (
              <li key={`${d.kind}-${d.cardId}-${i}`}>
                <Link
                  to={`/churning/${d.cardId}`}
                  className="flex items-center gap-3 py-2.5 transition-colors hover:bg-accent rounded-lg px-1 -mx-1"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{d.label}</p>
                    <p className="text-xs text-muted-foreground">{d.cardName}</p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
                      left <= 14
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-surface-container-high text-muted-foreground',
                    )}
                  >
                    {left === 0 ? 'Today' : left === 1 ? 'Tomorrow' : `${left}d left`}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
