// Dashboard (home) — Simplifi-style: greeting, the account hierarchy,
// review queues, recent activity, top categories, and card deadlines.
// The old Spending Plan home (safe-to-spend hero, planned income, bills,
// savings goals, watched categories) was removed at Daniel's direction
// (2026-10-20); Budgets remains the forward-looking planning surface, and
// the spending-plan data layer still powers the Reports forecast baseline.

import { useMemo } from 'react'
import AccountsOverview from '@/components/dashboard/AccountsOverview'
import ChurnDeadlinesWidget from '@/components/dashboard/ChurnDeadlinesWidget'
import RecentTransactions from '@/components/dashboard/RecentTransactions'
import ReviewTransactions from '@/components/dashboard/ReviewTransactions'
import TopCategories from '@/components/dashboard/TopCategories'
import { useMyProfile } from '@/data/hooks'
import { getGreeting } from '@/lib/greeting'

function dateLabel(today: Date) {
  return today.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export default function DashboardPage() {
  const today = useMemo(() => new Date(), [])
  const { data: profile } = useMyProfile()
  // Time-of-day greeting addressed to the household display name ("Good
  // morning, Dara"). Falls back to "Dara" when no name is set; the name is
  // editable in Settings → General.
  const displayName = profile?.first_name?.trim() || 'Dara'

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {getGreeting(displayName)}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{dateLabel(today)}</p>
      </div>

      <AccountsOverview />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ReviewTransactions />
        <RecentTransactions />
        <TopCategories />
        <ChurnDeadlinesWidget />
      </div>
    </div>
  )
}
