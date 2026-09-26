// The in-app route table. Home is the Simplifi-style spending plan; the old
// Budget/Explore/Activity/Reports pages were removed in the barebones strip.

import { Navigate, Route } from 'react-router-dom'
import AccountDetailPage from '@/pages/AccountDetailPage'
import AccountsPage from '@/pages/AccountsPage'
import AllTransactionsPage from '@/pages/AllTransactionsPage'
import ChurnCardDetailPage from '@/pages/ChurnCardDetailPage'
import ChurningPage from '@/pages/ChurningPage'
import RecurringChargesPage from '@/pages/RecurringChargesPage'
import ReportsPage from '@/pages/ReportsPage'
import SeparateAccountDetailPage from '@/pages/SeparateAccountDetailPage'
import SettingsPage from '@/pages/SettingsPage'
import SpendingPlanPage from '@/pages/SpendingPlanPage'

/** Children of the AppLayout route. */
export const AppRouteTable = (
  <>
    <Route path="/" element={<SpendingPlanPage />} />
    {/* Spending Plan is its own sidebar entry; it renders the same home page. */}
    <Route path="/spending-plan" element={<SpendingPlanPage />} />
    <Route path="/accounts" element={<AccountsPage />} />
    <Route path="/accounts/separate/:id" element={<SeparateAccountDetailPage />} />
    <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
    {/* Import CSV is disabled — redirects to home. */}
    <Route path="/import" element={<Navigate to="/" replace />} />
    <Route path="/add-transaction" element={<Navigate to="/transactions?tab=add-transaction" replace />} />
    <Route path="/transfer" element={<Navigate to="/transactions?tab=transfers" replace />} />
    <Route path="/transfers/review" element={<Navigate to="/transactions?tab=transfers" replace />} />
    <Route path="/transactions" element={<AllTransactionsPage />} />
    <Route path="/recurring" element={<RecurringChargesPage />} />
    <Route path="/reports" element={<ReportsPage />} />
    <Route path="/churning" element={<ChurningPage />} />
    <Route path="/churning/:cardId" element={<ChurnCardDetailPage />} />
    <Route path="/settings" element={<SettingsPage />} />
  </>
)
