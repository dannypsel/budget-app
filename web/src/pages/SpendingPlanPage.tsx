// Spending plan (home) — Simplifi-style: planned income, bills, savings goals,
// month-to-date net spending, and the "safe to spend" hero. Sign convention:
// Transaction.amount > 0 = spend/outflow, < 0 = income/inflow; net spending uses
// the same definition as the transactions views (outflows minus reimbursement
// credit magnitudes, exclude_from_totals=true rows — e.g. transfer legs — already
// filtered by the fetch).

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ProgressBar } from '@/components/finance/ProgressBar'
import {
  usePlannedIncome,
  useSavePlannedIncome,
  useBills,
  useCreateBill,
  useUpdateBill,
  useDeleteBill,
  useSavingsGoals,
  useCreateSavingsGoal,
  useUpdateSavingsGoal,
  useDeleteSavingsGoal,
  useTransactionsMonth,
  useChurnCards,
  useAllChurnBonuses,
  useAllChurnCredits,
  useMyProfile,
} from '@/data/hooks'
import { computeSpendingPlan } from '@/lib/spendingPlan'
import { buildChurnDeadlines, daysUntil } from '@/lib/churning'
import { sumNetSpend, type Bill, type BillInsert, type SavingsGoal, type SavingsGoalInsert } from '@/types/domain'
import { formatCurrency } from '@/lib/money'
import { getGreeting } from '@/lib/greeting'
import { cn } from '@/lib/utils'

function monthLabel(today: Date) {
  return today.toLocaleString(undefined, { month: 'long', year: 'numeric' })
}

export default function SpendingPlanPage() {
  const today = useMemo(() => new Date(), [])
  const { data: plannedIncome } = usePlannedIncome()
  const { data: bills = [] } = useBills()
  const { data: goals = [] } = useSavingsGoals()
  const { data: monthTxns = [] } = useTransactionsMonth(today)
  const { data: profile } = useMyProfile()
  // Time-of-day greeting addressed to the household display name ("Good morning,
  // Dara — Safe to spend · September 2026"). Falls back to "Dara" when no name
  // is set; the name is editable in Settings → General.
  const displayName = profile?.first_name?.trim() || 'Dara'
  const eyebrow = `${getGreeting(displayName)} — Safe to spend · ${monthLabel(today)}`

  const monthSpending = useMemo(() => sumNetSpend(monthTxns), [monthTxns])
  const plan = useMemo(
    () =>
      computeSpendingPlan({
        plannedIncome: plannedIncome ?? 0,
        bills,
        goals,
        monthSpending,
        today,
      }),
    [plannedIncome, bills, goals, monthSpending, today],
  )

  const [incomeOpen, setIncomeOpen] = useState(false)
  const [billDialog, setBillDialog] = useState<{ bill: Bill | null } | null>(null)
  const [goalDialog, setGoalDialog] = useState<{ goal: SavingsGoal | null } | null>(null)

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <h1 className="sr-only">Spending plan</h1>

      {/* Hero: safe to spend */}
      <section className="card-surface relative overflow-hidden p-6 md:p-8">
        <p className="eyebrow mb-1">{eyebrow}</p>
        <p
          className={cn(
            'text-hero-number block',
            plan.safeToSpend < 0 ? 'text-destructive' : 'text-foreground',
          )}
        >
          {formatCurrency(plan.safeToSpend)}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {plan.daysRemaining} {plan.daysRemaining === 1 ? 'day' : 'days'} left · about{' '}
          {formatCurrency(plan.perDay)} per day
        </p>
        <div className="mt-4">
          <ProgressBar
            value={Math.min(100, plan.spentFraction * 100)}
            fillClassName={plan.spentFraction > 1 ? 'bg-destructive' : 'bg-primary'}
            label="Spent versus planned"
          />
          <p className="mt-1.5 text-sm text-muted-foreground">
            Spent {formatCurrency(plan.spent)} of {formatCurrency(plan.planned)} planned
          </p>
        </div>

        <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-outline-variant/30 pt-4">
          <div>
            <dt className="eyebrow mb-0.5">Income</dt>
            <dd className="text-lg font-semibold tabular-nums text-foreground">
              {formatCurrency(plannedIncome ?? 0)}
            </dd>
          </div>
          <div>
            <dt className="eyebrow mb-0.5">Bills</dt>
            <dd className="text-lg font-semibold tabular-nums text-foreground">
              {formatCurrency(plan.billsTotal)}
            </dd>
          </div>
          <div>
            <dt className="eyebrow mb-0.5">Goals</dt>
            <dd className="text-lg font-semibold tabular-nums text-foreground">
              {formatCurrency(plan.goalsTotal)}
            </dd>
          </div>
        </dl>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Planned income */}
        <section className="card-surface p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-xl font-medium leading-7 text-foreground">Planned income</h3>
            <Button variant="ghost" size="sm" onClick={() => setIncomeOpen(true)}>
              <Pencil className="mr-1.5 h-4 w-4" aria-hidden />
              Edit
            </Button>
          </div>
          {plannedIncome == null ? (
            <p className="text-sm text-muted-foreground">
              Set your expected monthly take-home income to power the spending plan.
            </p>
          ) : (
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              {formatCurrency(plannedIncome)}
              <span className="ml-2 text-sm font-normal text-muted-foreground">/ month</span>
            </p>
          )}
        </section>

        {/* Bills */}
        <section className="card-surface p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-xl font-medium leading-7 text-foreground">Bills</h3>
            <Button variant="ghost" size="sm" onClick={() => setBillDialog({ bill: null })}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              Add
            </Button>
          </div>
          {bills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No bills yet — add rent, utilities, subscriptions and they'll count against
              your spending plan.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {bills.map((b) => (
                <BillRow key={b.id} bill={b} onEdit={() => setBillDialog({ bill: b })} />
              ))}
            </ul>
          )}
        </section>

        {/* Savings goals */}
        <section className="card-surface p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-xl font-medium leading-7 text-foreground">Savings goals</h3>
            <Button variant="ghost" size="sm" onClick={() => setGoalDialog({ goal: null })}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              Add
            </Button>
          </div>
          {goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No savings goals yet — earmark monthly contributions and the plan treats
              them as committed.
            </p>
          ) : (
            <ul className="space-y-4">
              {goals.map((g) => (
                <GoalRow key={g.id} goal={g} onEdit={() => setGoalDialog({ goal: g })} />
              ))}
            </ul>
          )}
        </section>

        <ChurnDeadlinesWidget />
      </div>

      <PlannedIncomeDialog open={incomeOpen} onOpenChange={setIncomeOpen} current={plannedIncome ?? null} />
      {billDialog && (
        <BillDialog
          bill={billDialog.bill}
          onOpenChange={(o) => !o && setBillDialog(null)}
        />
      )}
      {goalDialog && (
        <GoalDialog
          goal={goalDialog.goal}
          onOpenChange={(o) => !o && setGoalDialog(null)}
        />
      )}
    </div>
  )
}

// ─── Bills ──────────────────────────────────────────────────────────────────

function BillRow({ bill, onEdit }: { bill: Bill; onEdit: () => void }) {
  const updateBill = useUpdateBill()
  const deleteBill = useDeleteBill()
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <li className={cn('flex items-center gap-3 py-3', !bill.is_active && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{bill.name}</p>
        <p className="text-xs text-muted-foreground">
          {bill.category ? `${bill.category} · ` : ''}Due day {bill.due_day}
        </p>
      </div>
      <p className="shrink-0 text-base font-semibold tabular-nums text-foreground">
        {formatCurrency(Number(bill.amount))}
      </p>
      <Switch
        checked={bill.is_active}
        onCheckedChange={(v) => void updateBill.mutateAsync({ id: bill.id, patch: { is_active: v } })}
        aria-label={`${bill.name} active`}
      />
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${bill.name}`}>
        <Pencil className="h-4 w-4" aria-hidden />
      </Button>
      {confirmDelete ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            toast.promise(deleteBill.mutateAsync(bill.id), {
              loading: `Deleting ${bill.name}…`,
              success: `${bill.name} deleted`,
              error: (e) => (e instanceof Error ? e.message : 'Could not delete bill'),
            })
          }}
        >
          Delete?
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
          aria-label={`Delete ${bill.name}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </li>
  )
}

function BillDialog({
  bill,
  onOpenChange,
}: {
  bill: Bill | null
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(bill?.name ?? '')
  const [amount, setAmount] = useState(bill ? String(bill.amount) : '')
  const [dueDay, setDueDay] = useState(bill ? String(bill.due_day) : '')
  const [category, setCategory] = useState(bill?.category ?? '')
  const createBill = useCreateBill()
  const updateBill = useUpdateBill()
  const pending = createBill.isPending || updateBill.isPending

  async function save() {
    const parsedAmount = Number(amount)
    const parsedDay = Math.min(31, Math.max(1, Math.round(Number(dueDay) || 1)))
    if (!name.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error('Enter a name and a positive amount.')
      return
    }
    const input: BillInsert = {
      name: name.trim(),
      amount: parsedAmount,
      due_day: parsedDay,
      category: category.trim() || undefined,
    }
    if (bill) {
      await updateBill.mutateAsync({ id: bill.id, patch: input })
      toast.success('Bill updated')
    } else {
      await createBill.mutateAsync(input)
      toast.success('Bill added')
    }
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{bill ? 'Edit bill' : 'Add bill'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="bill-name">Name</Label>
            <Input id="bill-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="bill-amount">Amount ($)</Label>
              <Input
                id="bill-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bill-due">Due day (1–31)</Label>
              <Input
                id="bill-due"
                inputMode="numeric"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-category">Category label (optional)</Label>
            <Input
              id="bill-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Utilities"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : bill ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Savings goals ──────────────────────────────────────────────────────────

function GoalRow({ goal, onEdit }: { goal: SavingsGoal; onEdit: () => void }) {
  const deleteGoal = useDeleteSavingsGoal()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const target = Number(goal.target_amount)

  return (
    <li>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{goal.name}</p>
          <p className="text-xs text-muted-foreground">
            {formatCurrency(Number(goal.monthly_contribution))} / month · target{' '}
            {formatCurrency(target)}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${goal.name}`}>
          <Pencil className="h-4 w-4" aria-hidden />
        </Button>
        {confirmDelete ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              toast.promise(deleteGoal.mutateAsync(goal.id), {
                loading: `Deleting ${goal.name}…`,
                success: `${goal.name} deleted`,
                error: (e) => (e instanceof Error ? e.message : 'Could not delete goal'),
              })
            }}
          >
            Delete?
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete ${goal.name}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
    </li>
  )
}

function GoalDialog({
  goal,
  onOpenChange,
}: {
  goal: SavingsGoal | null
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(goal ? String(goal.target_amount) : '')
  const [monthly, setMonthly] = useState(goal ? String(goal.monthly_contribution) : '')
  const createGoal = useCreateSavingsGoal()
  const updateGoal = useUpdateSavingsGoal()
  const pending = createGoal.isPending || updateGoal.isPending

  async function save() {
    const parsedTarget = Number(target)
    const parsedMonthly = Number(monthly)
    if (
      !name.trim() ||
      !Number.isFinite(parsedTarget) ||
      parsedTarget <= 0 ||
      !Number.isFinite(parsedMonthly) ||
      parsedMonthly < 0
    ) {
      toast.error('Enter a name, a positive target, and a monthly contribution.')
      return
    }
    const input: SavingsGoalInsert = {
      name: name.trim(),
      target_amount: parsedTarget,
      monthly_contribution: parsedMonthly,
    }
    if (goal) {
      await updateGoal.mutateAsync({ id: goal.id, patch: input })
      toast.success('Goal updated')
    } else {
      await createGoal.mutateAsync(input)
      toast.success('Goal added')
    }
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{goal ? 'Edit savings goal' : 'Add savings goal'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="goal-name">Name</Label>
            <Input id="goal-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="goal-target">Target ($)</Label>
              <Input
                id="goal-target"
                inputMode="decimal"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-monthly">Monthly ($)</Label>
              <Input
                id="goal-monthly"
                inputMode="decimal"
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : goal ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Planned income ─────────────────────────────────────────────────────────

function PlannedIncomeDialog({
  open,
  onOpenChange,
  current,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: number | null
}) {
  const [value, setValue] = useState(current != null ? String(current) : '')
  const saveIncome = useSavePlannedIncome()

  async function save() {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error('Enter a valid monthly income.')
      return
    }
    await saveIncome.mutateAsync(parsed)
    toast.success('Planned income saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Planned monthly income</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="income">Expected take-home per month ($)</Label>
          <Input
            id="income"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saveIncome.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saveIncome.isPending}>
            {saveIncome.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Churning deadlines widget ──────────────────────────────────────────────

function ChurnDeadlinesWidget() {
  const { data: cards = [] } = useChurnCards()
  const { data: bonuses = [] } = useAllChurnBonuses()
  const { data: credits = [] } = useAllChurnCredits()
  const deadlines = useMemo(
    () => buildChurnDeadlines(cards, bonuses, credits).slice(0, 5),
    [cards, bonuses, credits],
  )

  return (
    <section className="card-surface p-6">
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
