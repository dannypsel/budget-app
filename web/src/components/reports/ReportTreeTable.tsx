// Collapsible tree table (Simplifi's "Expense transactions by category" /
// "Tax detail"): group ▸ category ▸ transactions with "Total X" subtotal rows.
// Rows come from lib/reportTree.flattenTree.

import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOpenTransaction } from '@/components/finance/transactionDialog'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { flattenTree, type TreeNode } from '@/lib/reportTree'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'
import { displayName, txnTags, type Account, type UUID } from '@/types/domain'

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}/${y}`
}

export function ReportTreeTable({
  root,
  title,
  firstColumn = 'Category',
  accountsById,
  flow,
  summaryOnly = false,
  headerRight,
}: {
  root: TreeNode
  title: string
  firstColumn?: string
  accountsById: Map<UUID, Account>
  /** Displayed sign for transaction rows: spend shows outflows positive. */
  flow: 'spend' | 'income' | 'mixed'
  /** Simplifi's "Summary" view: group rows and totals only, no transaction rows. */
  summaryOnly?: boolean
  headerRight?: ReactNode
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const openTxn = useOpenTransaction()
  const rows = useMemo(
    () => flattenTree(root, collapsed).filter((r) => !(summaryOnly && r.kind === 'txn')),
    [root, collapsed, summaryOnly],
  )
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const expandAll = () => setCollapsed(new Set())
  const collapseAll = () => setCollapsed(new Set(root.children.map((c) => c.id)))

  const txnAmount = (amount: number) =>
    flow === 'income' ? -amount : flow === 'mixed' ? Math.abs(amount) : amount

  return (
    <section className="card-surface p-4 md:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <div className="flex items-center gap-3 text-xs">
          <button type="button" onClick={expandAll} className="text-primary hover:underline">
            Expand all
          </button>
          <button type="button" onClick={collapseAll} className="text-primary hover:underline">
            Collapse all
          </button>
          {headerRight}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed text-sm">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[10%]" />
            <col className="w-[18%]" />
            <col className="w-[22%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left text-xs font-semibold text-muted-foreground">
              <th className="py-2 pr-3">{firstColumn}</th>
              <th className="py-2 pr-3">Date</th>
              <th className="py-2 pr-3">Account</th>
              <th className="py-2 pr-3">Payee</th>
              <th className="py-2 pr-3">Tags</th>
              <th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const pad = { paddingLeft: `${r.depth * 16}px` }
              if (r.kind === 'header') {
                const hasBody = r.node.children.length > 0 || r.node.txns.length > 0
                return (
                  <tr key={`h-${r.node.id}-${i}`} className={cn(r.depth === 0 && 'bg-surface-container-low')}>
                    <td colSpan={5} className="py-2 pr-3">
                      <button
                        type="button"
                        onClick={() => hasBody && toggle(r.node.id)}
                        aria-expanded={!r.collapsed}
                        className="flex items-center gap-1 font-medium text-foreground"
                        style={pad}
                      >
                        {hasBody &&
                          (r.collapsed ? (
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          ) : (
                            <ChevronDown className="h-4 w-4" aria-hidden />
                          ))}
                        {r.node.label}
                      </button>
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium">
                      {r.collapsed || r.depth === 0 ? formatCurrency(r.node.total) : ''}
                    </td>
                  </tr>
                )
              }
              if (r.kind === 'total') {
                return (
                  <tr key={`t-${r.node.id}-${i}`} className="border-b border-border">
                    <td colSpan={5} className="py-2 pr-3 font-semibold text-foreground">
                      <span style={pad}>Total {r.node.label}</span>
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums">{formatCurrency(r.node.total)}</td>
                  </tr>
                )
              }
              const t = r.txn
              const tags = txnTags(t).map((x) => x.name)
              return (
                <tr
                  key={`x-${t.id}-${i}`}
                  className={cn('text-muted-foreground', openTxn && 'cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none')}
                  {...(openTxn && {
                    tabIndex: 0,
                    'aria-label': `Open ${displayName(t)}`,
                    onClick: () => openTxn(t),
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openTxn(t)
                      }
                    },
                  })}
                >
                  <td className="py-1.5 pr-3">
                    <span style={pad} className="block truncate">
                      {t.categories?.name ?? 'Uncategorized'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3">{shortDate(t.effective_date)}</td>
                  <td className="truncate whitespace-nowrap py-1.5 pr-3">{accountsById.get(t.account_id)?.name ?? ''}</td>
                  <td className="truncate py-1.5 pr-3 text-foreground">{displayName(t)}</td>
                  <td className="py-1.5 pr-3">{tags.join(', ')}</td>
                  <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-foreground">
                    {formatCurrency(txnAmount(t.amount))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
