// Churning report: annual fees paid vs. money made (credits sold, bonuses,
// referrals) for the selected range. Churning categories are excluded from
// every other report, so this is where that money shows up. Offers to move
// annual-fee charges it finds elsewhere into Churning › Annual Fees.

import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAccountsWithBalance, useCategories, useTransactionsRange } from '@/data/hooks'
import { useOpenTransaction } from '@/components/finance/transactionDialog'
import { churningSummary, type ChurningLine } from '@/lib/churningMoney'
import { categoryPath } from '@/lib/categoryTree'
import { formatCurrency } from '@/lib/money'
import { formatShortDate, toISODate } from '@/lib/dates'
import { downloadCsv, rowsToCsv } from '@/lib/exportCsv'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { displayName } from '@/types/domain'

type ExportRef = { current: (() => void) | null }

/** Money made is positive, money spent negative: show it signed. */
function Signed({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('tabular-nums', value > 0 ? 'text-emerald-700 dark:text-emerald-400' : value < 0 ? 'text-foreground' : 'text-muted-foreground', className)}>
      {value > 0 ? '+' : value < 0 ? '−' : ''}
      {formatCurrency(Math.abs(value))}
    </span>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="card-surface border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">
        <Signed value={value} />
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function LineTable({ title, first, lines }: { title: string; first: string; lines: ChurningLine[] }) {
  return (
    <section className="card-surface border border-border">
      <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">{title}</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{first}</TableHead>
            <TableHead className="text-right">Transactions</TableHead>
            <TableHead className="text-right">Net</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="font-medium">{l.label}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{l.txns.length}</TableCell>
              <TableCell className="text-right">
                <Signed value={l.net} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

export function ChurningReport({ start, end, exportRef }: { start: string; end: string; exportRef: ExportRef }) {
  const { data: txns = [], isLoading } = useTransactionsRange(start, end, { byPostedDate: true })
  const { data: categories = [] } = useCategories()
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const openTxn = useOpenTransaction()
  const summary = useMemo(() => churningSummary(txns, categories, accountsById), [txns, categories, accountsById])

  useEffect(() => {
    exportRef.current = () =>
      downloadCsv(
      `churning-${toISODate(new Date())}.csv`,
      rowsToCsv(
        ['Date', 'Account', 'Payee', 'Category', 'Amount (+ made / − spent)'],
          summary.txns.map((t) => [t.date, accountsById.get(t.account_id)?.name ?? '', displayName(t), categoryPath(byId.get(t.category_id!), byId), (-t.amount).toFixed(2)]),
        ),
      )
  })

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-muted-foreground">
        Everything in the <span className="font-medium text-foreground">Churning</span> category — annual fees, credits you
        sell, bonuses and referrals. Churning is excluded from spending, income and every other report, so they show where
        your money actually goes.
      </p>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading transactions…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Annual fees" value={-summary.fees} hint="Net of fee refunds" />
            <Stat label="Money made" value={summary.earned} hint="Credits sold, bonuses, referrals" />
            <Stat label="Net" value={summary.net} hint="Made − fees" />
          </div>

          {summary.txns.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No churning transactions in this range. Categorize a fee, a credit sale or a bonus as Churning to see it here.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <LineTable title="By type" first="Category" lines={summary.bySubcategory} />
                <LineTable title="By account" first="Account" lines={summary.byAccount} />
              </div>
              <section className="card-surface border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <h3 className="text-sm font-semibold text-foreground">Transactions</h3>
                  <Link to={`/transactions?q=${encodeURIComponent('category="Churning"')}`} className="text-xs font-medium text-primary">
                    Open in Transactions
                  </Link>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Payee</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...summary.txns]
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .map((t) => (
                        <TableRow
                          key={t.id}
                          className={openTxn ? 'cursor-pointer' : undefined}
                          onClick={openTxn ? () => openTxn(t) : undefined}
                        >
                          <TableCell className="whitespace-nowrap text-muted-foreground">{formatShortDate(t.date)}</TableCell>
                          <TableCell className="font-medium">{displayName(t)}</TableCell>
                          <TableCell className="text-muted-foreground">{byId.get(t.category_id!)?.name ?? 'Churning'}</TableCell>
                          <TableCell className="text-muted-foreground">{accountsById.get(t.account_id)?.name ?? ''}</TableCell>
                          <TableCell className="text-right">
                            <Signed value={-t.amount} />
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </section>
            </>
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Sold a credit or got a bonus paid by Venmo, Zelle or PayPal? Click it (here or in Transactions) and pick
        Churning › Credit Sales or Bonuses &amp; Referrals. If PocketLens linked it as a transfer, choose “Not a transfer — include in
        reports” first.
      </p>
    </div>
  )
}

/** Year-to-date churning money for the Churning page, linking to the full report. */
export function ChurningMoneyCard() {
  const today = useMemo(() => new Date(), [])
  const start = toISODate(new Date(today.getFullYear(), 0, 1))
  const { data: txns = [] } = useTransactionsRange(start, toISODate(today), { byPostedDate: true })
  const { data: categories = [] } = useCategories()
  const { data: accounts = [] } = useAccountsWithBalance()
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const s = useMemo(() => churningSummary(txns, categories, accountsById), [txns, categories, accountsById])
  return (
    <section aria-label="Churning money this year" className="card-surface flex flex-col gap-3 border border-border p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">Churning money · {today.getFullYear()}</p>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span>
            Fees <Signed value={-s.fees} />
          </span>
          <span>
            Made <Signed value={s.earned} />
          </span>
          <span className="font-semibold">
            Net <Signed value={s.net} />
          </span>
        </p>
      </div>
      <Link to="/reports?open=churning" className="text-sm font-medium text-primary">
        View churning report
      </Link>
    </section>
  )
}
