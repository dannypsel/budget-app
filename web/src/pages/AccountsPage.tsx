// All Accounts — a Simplifi-style account list: a total balance header (assets
// minus liabilities, credit shown negative), collapsible account-type groups
// with subtotals, and per-row drill-down to the account detail pages. Plaid
// accounts and manual "separate" accounts are listed in the same groups.

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { NewAccountDialog } from '@/components/finance/NewAccountDialog'
import { InstitutionLogo } from '@/components/finance/InstitutionLogo'
import { ErrorState } from '@/components/ErrorState'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  useAccountsWithBalance,
  useHideAccount,
  usePlaidItems,
  useSeparateAccounts,
  useSyncInProgress,
  useTriggerSync,
} from '@/data/hooks'
import { formatCurrency } from '@/lib/money'
import { isLiabilityType, type Account } from '@/types/domain'
import { cn } from '@/lib/utils'

// Plaid free trial tier caps a user at 10 linked Items (see plaid_client.py,
// SettingsView "10 banks, no card"). The New dialog disables the Plaid connect
// choice past that ceiling (manual accounts are still allowed).
const MAX_PLAID_CONNECTIONS = 10

type GroupKey = 'cash' | 'savings' | 'credit' | 'other'

const GROUP_ORDER: GroupKey[] = ['cash', 'savings', 'credit', 'other']

const GROUP_TITLE: Record<GroupKey, string> = {
  cash: 'Cash & Checking',
  savings: 'Savings',
  credit: 'Credit',
  other: 'Other',
}

const MANUAL_TYPE_LABEL: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit / debt',
  depository: 'Cash',
  investment: 'Investments',
  other: 'Other asset',
  loan: 'Loan',
}

// Plaid type names for the row subtitle when the subtype is missing.
const PLAID_TYPE_LABEL: Record<string, string> = {
  depository: 'Checking & Savings',
  investment: 'Investment',
  other: 'Other asset',
  credit: 'Credit Card',
  loan: 'Loan',
}

// Plaid accounts: depository w/ checking (or missing) subtype → cash;
// depository w/ savings subtype → savings; type credit → credit; everything
// else (loan, investment, other) → other.
function plaidGroup(type: string, subtype: string | null): GroupKey {
  if (type === 'credit') return 'credit'
  if (type === 'depository') return subtype === 'savings' ? 'savings' : 'cash'
  return 'other'
}

// Manual separate accounts: the New dialog writes 'checking' | 'savings' |
// 'credit'; older accounts use SEPARATE_ACCOUNT_TYPES values, mapped sensibly.
function separateGroup(type: string): GroupKey {
  if (type === 'credit') return 'credit'
  if (type === 'savings') return 'savings'
  if (type === 'checking' || type === 'depository') return 'cash'
  return 'other'
}

/** Liabilities render sign-flipped to net-worth convention in neutral dark text
 *  (never red): debt "-$3,240.12", an overpaid card "$50.00". */
function balanceDisplay(type: string, bal: number): string {
  return formatCurrency(isLiabilityType(type) ? -bal : bal)
}

/** A single account row. `account` is present only for Plaid accounts (they can
 *  be hidden); manual accounts have no delete affordance on this page (their
 *  detail page has its own delete). */
type AccountRow = {
  id: string
  to: string
  name: string
  subtitle: string
  type: string
  balance: number
  logo: string | null
  manual: boolean
  account: Account | null
}

function AccountRowView({
  row,
  onDeleteClick,
}: {
  row: AccountRow
  onDeleteClick: (account: Account) => void
}) {
  return (
    <div className="group flex items-center border-b border-outline-variant/30 last:border-0">
      <Link
        to={row.to}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {row.account ? (
          <InstitutionLogo logo={row.logo} className="h-7 w-7" />
        ) : (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card text-primary shadow-card">
            <Wallet className="h-3.5 w-3.5" aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{row.name}</p>
          <p className="truncate text-xs font-medium tracking-wide text-muted-foreground">
            {row.subtitle}
          </p>
        </div>
        <span className="shrink-0 text-base font-semibold tabular-nums tracking-tight text-foreground">
          {balanceDisplay(row.type, row.balance)}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
      {/* Fixed trailing gutter on EVERY row (delete button for Plaid accounts, an
          empty placeholder otherwise) so the chevrons line up down the group. */}
      {row.account ? (
        <button
          type="button"
          aria-label={`Delete ${row.name}`}
          onClick={() => row.account && onDeleteClick(row.account)}
          className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <Trash2 aria-hidden className="h-4 w-4" />
        </button>
      ) : (
        <div className="mr-3 h-8 w-8 shrink-0" aria-hidden />
      )}
    </div>
  )
}

/** One collapsible group card: title, sign-flipped subtotal, chevron toggle. */
function AccountGroup({
  title,
  total,
  rows,
  collapsed,
  onToggle,
  onDeleteClick,
}: {
  title: string
  total: number
  rows: AccountRow[]
  collapsed: boolean
  onToggle: () => void
  onDeleteClick: (account: Account) => void
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-outline-variant/40 bg-card shadow-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold tabular-nums tracking-tight text-muted-foreground">
            {formatCurrency(total)}
          </span>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none',
              collapsed && '-rotate-90',
            )}
            aria-hidden
          />
        </span>
      </button>
      {!collapsed && (
        <div className="border-t border-outline-variant/40">
          {rows.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No accounts here yet.</p>
          ) : (
            rows.map((row) => (
              <AccountRowView key={row.id} row={row} onDeleteClick={onDeleteClick} />
            ))
          )}
        </div>
      )}
    </section>
  )
}

/** Two-step dialog shown when the user clicks the delete button on a Plaid
 *  account row. Explains what "delete" means for a Plaid account (soft-hide,
 *  not full removal). */
function DeleteAccountDialog({
  account,
  institutionName,
  onConfirm,
  onCancel,
  isPending,
}: {
  account: Account
  institutionName: string
  onConfirm: () => void
  onCancel: () => void
  isPending: boolean
}) {
  return (
    <AlertDialog open onOpenChange={(v) => !v && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {account.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                Plaid connects banks at the institution level, not per-account. Deleting this
                account hides it from your balances and stops it from affecting your net worth
                — but your <strong className="text-foreground">{institutionName}</strong> connection
                stays active and your other accounts there will keep syncing.
              </p>
              <p>
                This account's transactions stay in your history. To permanently remove everything
                — including all transactions — go to{' '}
                <strong className="text-foreground">Settings → Linked Banks</strong> and unlink{' '}
                {institutionName} entirely.
              </p>
              <p className="font-medium text-foreground">
                Hide {account.name} from your balances?
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground ring-offset-background transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : 'Delete account'}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default function AccountsPage() {
  const accountsQuery = useAccountsWithBalance()
  const { data: accounts = [], isLoading } = accountsQuery
  const { data: separate = [] } = useSeparateAccounts()
  const { data: plaidItems = [] } = usePlaidItems()

  const [showNew, setShowNew] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({
    cash: false,
    savings: false,
    credit: false,
    other: false,
  })
  const [deleteTarget, setDeleteTarget] = useState<{
    account: Account
    institutionName: string
  } | null>(null)

  const sync = useTriggerSync()
  const syncing = useSyncInProgress()
  const busy = sync.isPending || syncing
  const hideAccount = useHideAccount()

  // Build the four Simplifi groups + the assets-minus-liabilities total in one
  // pass over Plaid accounts and manual separate accounts.
  const { groups, total } = useMemo(() => {
    const itemById = new Map(plaidItems.map((i) => [i.id, i]))
    const byGroup: Record<GroupKey, AccountRow[]> = {
      cash: [],
      savings: [],
      credit: [],
      other: [],
    }
    let net = 0

    const plaidMeta = (
      type: string,
      subtype: string | null,
      mask: string | null,
      inst: string,
    ) => {
      const label = subtype
        ? subtype.charAt(0).toUpperCase() + subtype.slice(1)
        : (PLAID_TYPE_LABEL[type] ?? type)
      return [inst, label, mask ? `•••• ${mask}` : null].filter(Boolean).join(' · ')
    }

    for (const a of accounts) {
      const item = a.plaid_item_id ? itemById.get(a.plaid_item_id) : undefined
      const institution = item?.institution_name ?? (a.plaid_item_id ? 'Linked bank' : 'Account')
      const bal = a.currentBalance ?? 0
      net += isLiabilityType(a.type) ? -bal : bal
      byGroup[plaidGroup(a.type, a.subtype)].push({
        id: a.id,
        to: `/accounts/${a.id}`,
        name: a.name,
        subtitle: plaidMeta(a.type, a.subtype, a.mask, institution),
        type: a.type,
        balance: bal,
        logo: item?.institution_logo ?? null,
        manual: false,
        account: a,
      })
    }

    for (const a of separate) {
      const bal = a.currentBalance ?? 0
      net += isLiabilityType(a.type) ? -bal : bal
      byGroup[separateGroup(a.type)].push({
        id: `sep-${a.id}`,
        to: `/accounts/separate/${a.id}`,
        name: a.name,
        subtitle: MANUAL_TYPE_LABEL[a.type] ?? a.type,
        type: a.type,
        balance: bal,
        logo: null,
        manual: true,
        account: null,
      })
    }

    // Largest balance by magnitude at the top within each group; name breaks ties.
    const byMagnitude = (a: AccountRow, b: AccountRow) =>
      Math.abs(b.balance) - Math.abs(a.balance) || a.name.localeCompare(b.name)
    for (const key of GROUP_ORDER) byGroup[key].sort(byMagnitude)

    return { groups: byGroup, total: net }
  }, [accounts, separate, plaidItems])

  const groupTotal = (rows: AccountRow[]) =>
    rows.reduce((s, r) => s + (isLiabilityType(r.type) ? -r.balance : r.balance), 0)

  const onDeleteClick = (account: Account) => {
    const item = account.plaid_item_id
      ? plaidItems.find((i) => i.id === account.plaid_item_id)
      : undefined
    setDeleteTarget({
      account,
      institutionName: item?.institution_name ?? 'your bank',
    })
  }

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <h1 className="sr-only">All Accounts</h1>

      {/* Header: heading + net total, actions on the right */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">All Accounts</p>
          <p className="text-3xl font-bold tabular-nums tracking-tight text-foreground">
            {formatCurrency(total)}
          </p>
          <p className="mt-0.5 text-xs font-medium tracking-wide text-muted-foreground">
            Assets minus liabilities · Balances include pending transactions where available
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            className="h-10 gap-2 rounded-full border-border bg-card px-4 text-muted-foreground shadow-none hover:bg-surface-container-high hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => sync.mutate()}
            disabled={busy}
          >
            <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} aria-hidden />
            {busy ? 'Syncing…' : 'Sync'}
          </Button>
          <Button
            variant="pill"
            size="pill"
            className="gap-2"
            onClick={() => setShowNew(true)}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New
          </Button>
        </div>
      </div>

      {/* See All Transactions link row */}
      <div>
        <Button variant="outline" asChild>
          <Link to="/transactions">See All Transactions</Link>
        </Button>
      </div>

      {/* Account groups */}
      {isLoading && <p className="py-2 text-sm text-muted-foreground">Loading…</p>}

      {accountsQuery.isError ? (
        <ErrorState
          onRetry={() => void accountsQuery.refetch()}
          error={accountsQuery.error}
          message="We couldn't load your accounts. Check your connection and try again."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {GROUP_ORDER.map((key) => (
            <AccountGroup
              key={key}
              title={GROUP_TITLE[key]}
              total={groupTotal(groups[key])}
              rows={groups[key]}
              collapsed={collapsed[key]}
              onToggle={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
              onDeleteClick={onDeleteClick}
            />
          ))}
        </div>
      )}

      <NewAccountDialog
        open={showNew}
        onOpenChange={setShowNew}
        plaidCapReached={plaidItems.length >= MAX_PLAID_CONNECTIONS}
      />

      {deleteTarget && (
        <DeleteAccountDialog
          account={deleteTarget.account}
          institutionName={deleteTarget.institutionName}
          isPending={hideAccount.isPending}
          onConfirm={() => {
            toast.promise(hideAccount.mutateAsync(deleteTarget.account.id), {
              loading: `Deleting ${deleteTarget.account.name}…`,
              success: `${deleteTarget.account.name} deleted`,
              error: (e) => (e instanceof Error ? e.message : 'Could not delete account'),
            })
            setDeleteTarget(null)
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
