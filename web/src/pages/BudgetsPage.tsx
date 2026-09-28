// Budgets — monthly per-category budget targets. Each row pairs the target
// (click to edit, saved to the budgets table) with that month's actual spend
// from the category_spend view — the same spend definition the transactions
// views use. Over-budget rows are flagged; a totals row sums the month.

import { useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ProgressBar } from '@/components/finance/ProgressBar'
import { useHorizontalWheel } from '@/hooks/useHorizontalWheel'
import {
  useCategories,
  useMonthBudgets,
  useSaveBudgetTarget,
  useSpendByCategory,
} from '@/data/hooks'
import { buildBudgetRows, budgetTotals, type BudgetRow } from '@/lib/budgetTotals'
import { formatCurrency } from '@/lib/money'
import { formatMonthLabel, toISODate } from '@/lib/dates'
import { cn } from '@/lib/utils'

export default function BudgetsPage() {
  const [month, setMonth] = useState(() => new Date())
  const monthFirst = toISODate(new Date(month.getFullYear(), month.getMonth(), 1))
  const { data: categories = [], isLoading: catsLoading } = useCategories()
  const { data: budgets = [], isLoading: budgetsLoading } = useMonthBudgets(monthFirst)
  const { data: spendRows = [] } = useSpendByCategory(month)

  const rows = useMemo(
    () =>
      buildBudgetRows(
        categories,
        budgets,
        spendRows.map((s) => ({ categoryId: s.category.id, total: s.total })),
      ),
    [categories, budgets, spendRows],
  )
  const totals = useMemo(() => budgetTotals(rows), [rows])
  const loading = catsLoading || budgetsLoading

  const shiftMonth = (delta: number) =>
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))

  const scrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(scrollRef)

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Budgets</h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => shiftMonth(-1)} aria-label="Previous month">
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </Button>
          <span className="min-w-36 text-center text-sm font-semibold tabular-nums text-foreground">
            {formatMonthLabel(month)}
          </span>
          <Button variant="ghost" size="icon" onClick={() => shiftMonth(1)} aria-label="Next month">
            <ChevronRight className="h-5 w-5" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Month totals */}
      <section className="grid grid-cols-3 gap-4">
        <div className="card-surface p-4">
          <p className="eyebrow">Budgeted</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatCurrency(totals.target)}</p>
        </div>
        <div className="card-surface p-4">
          <p className="eyebrow">Spent</p>
          <p
            className={cn(
              'mt-1 text-2xl font-bold tabular-nums',
              totals.overBudget && 'text-destructive',
            )}
          >
            {formatCurrency(totals.actual)}
          </p>
        </div>
        <div className="card-surface p-4">
          <p className="eyebrow">Remaining</p>
          <p
            className={cn(
              'mt-1 text-2xl font-bold tabular-nums',
              totals.remaining < 0 ? 'text-destructive' : 'text-money-income',
            )}
          >
            {formatCurrency(totals.remaining)}
          </p>
        </div>
      </section>

      <section className="card-surface p-4 md:p-6">
        <h2 className="eyebrow mb-4">Per-category budgets · {formatMonthLabel(month)}</h2>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading budgets…</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No categories yet — add some in Settings to start budgeting.
          </p>
        ) : (
          <div ref={scrollRef} className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Target</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="min-w-44">Progress</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <BudgetTableRow key={row.category} row={row} monthFirst={monthFirst} />
                ))}
                <TableRow className="font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(totals.target)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(totals.actual)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      totals.remaining < 0 ? 'text-destructive' : 'text-money-income',
                    )}
                  >
                    {formatCurrency(totals.remaining)}
                  </TableCell>
                  <TableCell>
                    <ProgressBar
                      value={totals.fraction * 100}
                      fillClassName={totals.overBudget ? 'bg-destructive' : 'bg-primary'}
                      label="Total budget progress"
                    />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Click a target to edit it. Clearing a target removes it for this month.
        </p>
      </section>
    </div>
  )
}

function BudgetTableRow({ row, monthFirst }: { row: BudgetRow; monthFirst: string }) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="mr-2">{row.category}</span>
        {row.overBudget && (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
            Over budget
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <TargetCell monthFirst={monthFirst} row={row} />
      </TableCell>
      <TableCell
        className={cn(
          'text-right tabular-nums',
          row.overBudget ? 'text-destructive' : 'text-foreground',
        )}
      >
        {formatCurrency(row.actual)}
      </TableCell>
      <TableCell
        className={cn(
          'text-right tabular-nums',
          row.target > 0 && row.remaining < 0 ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {row.target > 0 ? formatCurrency(row.remaining) : '—'}
      </TableCell>
      <TableCell>
        {row.target > 0 ? (
          <ProgressBar
            value={row.fraction * 100}
            fillClassName={row.overBudget ? 'bg-destructive' : 'bg-primary'}
            label={`${row.category} budget progress`}
          />
        ) : (
          <span className="text-xs text-muted-foreground">No target</span>
        )}
      </TableCell>
    </TableRow>
  )
}

/** Click-to-edit budget target: Enter/blur commits, Escape cancels, clearing
 *  the field deletes the target for the month. */
function TargetCell({ monthFirst, row }: { monthFirst: string; row: BudgetRow }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const save = useSaveBudgetTarget()

  function commit() {
    const trimmed = value.trim()
    if (trimmed === '') {
      if (row.target > 0) void save.mutateAsync({ monthFirstISO: monthFirst, category: row.category, target: null })
    } else {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed) && parsed >= 0 && parsed !== row.target) {
        void save.mutateAsync({ monthFirstISO: monthFirst, category: row.category, target: parsed })
      }
    }
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(row.target > 0 ? String(row.target) : '')
          setEditing(true)
        }}
        className="rounded px-1.5 py-0.5 tabular-nums text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={`Edit ${row.category} budget target`}
      >
        {row.target > 0 ? (
          formatCurrency(row.target)
        ) : (
          <span className="text-sm text-muted-foreground underline decoration-dotted underline-offset-2">
            Set target
          </span>
        )}
      </button>
    )
  }

  return (
    <Input
      autoFocus
      inputMode="decimal"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') setEditing(false)
      }}
      className="ml-auto h-8 w-28 text-right tabular-nums"
      aria-label={`${row.category} budget target`}
    />
  )
}
