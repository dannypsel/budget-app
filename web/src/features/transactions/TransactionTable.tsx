// Simplifi-style register grid: checkbox · Date · Account · Reviewed · Payee ·
// Category · (Tags) · (Exclusion) · Amount · column settings. Rows group under a
// pinned "Pending" header, then one collapsible header per month. Expenses show
// as plain magnitudes, income as green "+" amounts (Simplifi's register).

import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Circle, Flag, Paperclip, Settings } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CategoryBadge } from '@/components/finance/CategoryBadge'
import { groupRegister, monthLabel, PENDING, rowDate } from './registerGroups'
import { cn } from '@/lib/utils'
import {
  displayName,
  hasSplits,
  isReimbursement,
  isTransfer,
  txnSplits,
  USER_FLAG_COLORS,
  type Account,
  type Transaction,
  type UUID,
} from '@/types/domain'

export type RegisterSort = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'payee'

export interface RegisterColumns {
  account: boolean
  reviewed: boolean
  category: boolean
  tags: boolean
  exclusion: boolean
}

const amountFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function RegisterAmount({ amount, reimbursement }: { amount: number; reimbursement?: boolean }) {
  const income = amount < 0 && !reimbursement
  return (
    <span className={cn('tabular-nums', income ? 'font-medium text-money-income' : 'text-foreground')}>
      {amount < 0 ? '+' : ''}
      {amountFmt.format(Math.abs(amount))}
    </span>
  )
}

function CategoryCell({ t }: { t: Transaction }) {
  if (isReimbursement(t)) return <span>Reimbursement{t.categories?.name ? ` · ${t.categories.name}` : ''}</span>
  if (isTransfer(t)) return <span>Transfer</span>
  if (hasSplits(t))
    return (
      <span className="flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground">Split</span>
        {txnSplits(t).map((s) => (
          <CategoryBadge key={s.id} category={s.categories} />
        ))}
      </span>
    )
  return <span className={cn(!t.categories && 'text-muted-foreground')}>{t.categories?.name ?? 'Uncategorized'}</span>
}

function exclusionLabel(t: Transaction): string {
  if (isTransfer(t)) return 'Transfer'
  if (t.hidden) return 'Hidden'
  if (t.exclude_from_totals || t.categories?.exclude_from_reports) return 'Excluded'
  return ''
}

export function TransactionTable({
  transactions,
  accountsById,
  onSelect,
  selectedIds,
  onToggleSelect,
  onSetSelection,
  onToggleReviewed,
  columns,
  onColumnsChange,
  sort = 'date-desc',
  onSortChange,
  renderTags,
  attachmentCounts,
  grouped = true,
}: {
  transactions: Transaction[]
  accountsById: Map<UUID, Account>
  onSelect?: (t: Transaction) => void
  selectedIds?: Set<UUID>
  onToggleSelect?: (t: Transaction) => void
  /** Header checkbox: select / clear every visible row. */
  onSetSelection?: (ids: Set<UUID>) => void
  onToggleReviewed?: (t: Transaction) => void
  columns: RegisterColumns
  onColumnsChange?: (c: RegisterColumns) => void
  sort?: RegisterSort
  onSortChange?: (s: RegisterSort) => void
  renderTags?: (t: Transaction) => ReactNode
  attachmentCounts?: Map<UUID, number>
  /** Pending + month headers (date sorts only). */
  grouped?: boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const groups = useMemo(
    () => (grouped ? groupRegister(transactions) : [['__all__', transactions] as [string, Transaction[]]]),
    [transactions, grouped],
  )
  const selectable = !!(selectedIds && onToggleSelect)
  const allSelected = selectable && transactions.length > 0 && transactions.every((t) => selectedIds!.has(t.id))
  const colCount =
    1 + (selectable ? 1 : 0) + (columns.account ? 1 : 0) + (columns.reviewed && onToggleReviewed ? 1 : 0) + 1 +
    (columns.category ? 1 : 0) + (columns.tags && renderTags ? 1 : 0) + (columns.exclusion ? 1 : 0) + 2

  const sortHeader = (label: string, desc: RegisterSort, asc: RegisterSort, className?: string) => {
    const active = sort === desc || sort === asc
    return (
      <th className={cn('py-3 pr-3 font-semibold', className)}>
        <button
          type="button"
          onClick={() => onSortChange?.(sort === desc ? asc : desc)}
          className="inline-flex items-center gap-1 hover:text-primary"
          aria-label={`Sort by ${label.toLowerCase()}`}
        >
          {label}
          {active && (sort === desc ? <ArrowDown className="h-3.5 w-3.5" aria-hidden /> : <ArrowUp className="h-3.5 w-3.5" aria-hidden />)}
        </button>
      </th>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-foreground">
            {selectable && (
              <th className="w-10 py-3 pl-3">
                <input
                  type="checkbox"
                  aria-label="Select all transactions"
                  checked={allSelected}
                  onChange={() => onSetSelection?.(allSelected ? new Set() : new Set(transactions.map((t) => t.id)))}
                  className="h-4 w-4 accent-primary"
                />
              </th>
            )}
            {sortHeader('Date', 'date-desc', 'date-asc', 'w-32 pl-3')}
            {columns.account && <th className="w-40 py-3 pr-3 font-semibold">Account</th>}
            {columns.reviewed && onToggleReviewed && (
              <th className="w-10 py-3 pr-3" aria-label="Reviewed">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              </th>
            )}
            <th className="py-3 pr-3 font-semibold">
              <button type="button" onClick={() => onSortChange?.('payee')} className="hover:text-primary" aria-label="Sort by payee">
                Payee
              </button>
            </th>
            {columns.category && <th className="w-48 py-3 pr-3 font-semibold">Category</th>}
            {columns.tags && renderTags && <th className="w-60 py-3 pr-3 font-semibold">Tags</th>}
            {columns.exclusion && <th className="w-24 py-3 pr-3 font-semibold">Exclusion</th>}
            {sortHeader('Amount', 'amount-desc', 'amount-asc', 'w-32 border-l border-border pl-3 text-right [&>button]:ml-auto [&>button]:flex')}
            <th className="w-10 py-3 pr-2 text-right">
              {onColumnsChange && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Customize columns" className="rounded p-1 text-muted-foreground hover:text-foreground">
                      <Settings className="h-4 w-4" aria-hidden />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>Columns</DropdownMenuLabel>
                    {(
                      [
                        ['account', 'Account'],
                        ['reviewed', 'Reviewed'],
                        ['category', 'Category'],
                        ['tags', 'Need/Want + Fixed/Variable tags'],
                        ['exclusion', 'Exclusion'],
                      ] as [keyof RegisterColumns, string][]
                    ).map(([k, label]) => (
                      <DropdownMenuCheckboxItem
                        key={k}
                        checked={columns[k]}
                        onCheckedChange={(v) => onColumnsChange({ ...columns, [k]: !!v })}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </th>
          </tr>
        </thead>
        {groups.map(([key, rows]) => {
          const isCollapsed = collapsed.has(key)
          return (
            <tbody key={key}>
              {grouped && (
                <tr className="bg-surface-container-low">
                  <td colSpan={colCount} className="py-0">
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev)
                          if (next.has(key)) next.delete(key)
                          else next.add(key)
                          return next
                        })
                      }
                      className="flex w-full items-center gap-3 px-3 py-4 text-left font-semibold text-foreground"
                    >
                      {isCollapsed ? <ChevronRight className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                      <h2 className="text-sm">{key === PENDING ? 'Pending' : monthLabel(key)}</h2>
                    </button>
                  </td>
                </tr>
              )}
              {!isCollapsed &&
                rows.map((t) => {
                  const account = accountsById.get(t.account_id)
                  return (
                    <tr
                      key={t.id}
                      onClick={() => onSelect?.(t)}
                      className={cn(
                        'cursor-pointer border-b border-border transition-colors hover:bg-accent',
                        selectedIds?.has(t.id) && 'bg-primary/5',
                      )}
                    >
                      {selectable && (
                        <td className="py-4 pl-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds!.has(t.id)}
                            onChange={() => onToggleSelect!(t)}
                            aria-label={`Select ${displayName(t)}`}
                            className="h-4 w-4 accent-primary"
                          />
                        </td>
                      )}
                      <td className="whitespace-nowrap py-4 pl-3 pr-3 text-foreground">{rowDate(t.effective_date)}</td>
                      {columns.account && <td className="max-w-40 truncate py-4 pr-3 text-foreground">{account?.name ?? ''}</td>}
                      {columns.reviewed && onToggleReviewed && (
                        <td className="py-4 pr-3" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => onToggleReviewed(t)}
                            aria-label={t.reviewed ? `Mark ${displayName(t)} as unreviewed` : `Mark ${displayName(t)} as reviewed`}
                            aria-pressed={!!t.reviewed}
                            className={cn('flex items-center', t.reviewed ? 'text-secondary' : 'text-muted-foreground/50 hover:text-muted-foreground')}
                          >
                            {t.reviewed ? <CheckCircle2 className="h-5 w-5" aria-hidden /> : <Circle className="h-5 w-5" aria-hidden />}
                          </button>
                        </td>
                      )}
                      <td className="py-4 pr-3">
                        <span className="flex items-center gap-1.5 text-foreground">
                          {t.user_flag && (
                            <Flag
                              className="h-3.5 w-3.5 shrink-0"
                              style={{ color: USER_FLAG_COLORS[t.user_flag], fill: USER_FLAG_COLORS[t.user_flag] }}
                              aria-label={`${t.user_flag.toLowerCase()} flag`}
                            />
                          )}
                          <span className="truncate">{displayName(t)}</span>
                          {attachmentCounts?.get(t.id) ? (
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />
                          ) : null}
                        </span>
                        {t.original_description && t.original_description !== displayName(t) && (
                          <span className="block truncate text-xs text-muted-foreground" title="Statement name">
                            {t.original_description}
                          </span>
                        )}
                      </td>
                      {columns.category && (
                        <td className="max-w-48 truncate whitespace-nowrap py-4 pr-3 text-foreground">
                          <CategoryCell t={t} />
                          {t.pending && !grouped && <span className="ml-2 text-xs font-semibold text-warning">Pending</span>}
                        </td>
                      )}
                      {columns.tags && renderTags && (
                        <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                          {renderTags(t)}
                        </td>
                      )}
                      {columns.exclusion && <td className="py-4 pr-3 text-muted-foreground">{exclusionLabel(t)}</td>}
                      <td className="whitespace-nowrap border-l border-border py-4 pl-3 pr-3 text-right">
                        <RegisterAmount amount={t.amount} reimbursement={isReimbursement(t)} />
                      </td>
                      <td />
                    </tr>
                  )
                })}
            </tbody>
          )
        })}
      </table>
    </div>
  )
}
