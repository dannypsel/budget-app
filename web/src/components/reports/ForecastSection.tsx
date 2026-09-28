// Forecast — the forward-looking half of Reports. The monthly baseline is
// computed LIVE from the spending plan (planned income − active bills −
// savings contributions − this month's budget targets) with the math shown, so
// it is never a hardcoded number. A manual override edits the baseline in
// place ("Use plan" restores the live value); adjustments layer named
// income/spending tweaks on top for any horizon length.

import { useMemo, useRef, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useHorizontalWheel } from '@/hooks/useHorizontalWheel'
import {
  useAccountsWithBalance,
  useBills,
  useCreateForecastAdjustment,
  useDeleteForecastAdjustment,
  useForecastAdjustments,
  useMonthBudgets,
  usePlannedIncome,
  useSavingsGoals,
} from '@/data/hooks'
import { computeForecastBaseline, projectForecast } from '@/lib/forecast'
import {
  chartTooltipItemStyle,
  chartTooltipLabelStyle,
  chartTooltipStyle,
} from '@/lib/chartTooltip'
import { formatCurrency } from '@/lib/money'
import { toISODate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import type {
  ForecastAdjustment,
  ForecastAdjustmentDirection,
  ForecastAdjustmentInsert,
  ForecastAdjustmentKind,
} from '@/types/domain'

const END_LINE = '#16a34a'

export default function ForecastSection() {
  const today = useMemo(() => new Date(), [])
  const startMonthFirstISO = toISODate(new Date(today.getFullYear(), today.getMonth(), 1))

  const { data: plannedIncome = null } = usePlannedIncome()
  const { data: bills = [] } = useBills()
  const { data: goals = [] } = useSavingsGoals()
  const { data: budgets = [] } = useMonthBudgets(startMonthFirstISO)
  const { data: adjustments = [] } = useForecastAdjustments()
  const { data: accounts = [] } = useAccountsWithBalance()

  const deleteAdjustment = useDeleteForecastAdjustment()

  // ── live baseline ──────────────────────────────────────────────────────────
  const terms = useMemo(
    () =>
      computeForecastBaseline(
        plannedIncome,
        bills,
        goals,
        budgets.map((b) => Number(b.target)),
      ),
    [plannedIncome, bills, goals, budgets],
  )

  /** Manual override text; null = using the live plan value. */
  const [overrideText, setOverrideText] = useState<string | null>(null)
  const usingPlan = overrideText == null
  const overrideNum = overrideText == null ? null : Number(overrideText)
  const baseline = usingPlan || overrideText?.trim() === '' || overrideNum == null || !Number.isFinite(overrideNum)
    ? terms.baseline
    : overrideNum

  // ── horizon ────────────────────────────────────────────────────────────────
  const [horizonText, setHorizonText] = useState('12')
  const horizonParsed = Math.floor(Number(horizonText))
  const horizonMonths = Number.isFinite(horizonParsed) && horizonParsed > 0 ? horizonParsed : 12

  // ── projection ─────────────────────────────────────────────────────────────
  const startingNetWorth = useMemo(
    () => accounts.reduce((s, a) => s + Number(a.currentBalance ?? 0), 0),
    [accounts],
  )
  const projection = useMemo(
    () =>
      projectForecast({
        startingNetWorth,
        baselineMonthly: baseline,
        adjustments,
        horizonMonths,
        startMonthFirstISO,
      }),
    [startingNetWorth, baseline, adjustments, horizonMonths, startMonthFirstISO],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(scrollRef)

  return (
    <section className="card-surface p-4 md:p-6">
      <h2 className="eyebrow mb-4">Forecast</h2>

      {/* Live baseline with provenance */}
      <div className="rounded-xl bg-surface-container-low p-4">
        <p className="eyebrow mb-2">Monthly baseline · live from spending plan</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
          <span className="text-muted-foreground">
            Income <strong className="text-foreground">{formatCurrency(terms.plannedIncome)}</strong>
          </span>
          <span aria-hidden className="text-muted-foreground">−</span>
          <span className="text-muted-foreground">
            Bills <strong className="text-foreground">{formatCurrency(terms.billsTotal)}</strong>
          </span>
          <span aria-hidden className="text-muted-foreground">−</span>
          <span className="text-muted-foreground">
            Savings <strong className="text-foreground">{formatCurrency(terms.goalsTotal)}</strong>
          </span>
          <span aria-hidden className="text-muted-foreground">−</span>
          <span className="text-muted-foreground">
            Budgets <strong className="text-foreground">{formatCurrency(terms.budgetsTotal)}</strong>
          </span>
          <span aria-hidden className="text-muted-foreground">=</span>
          <strong className={cn('text-base', terms.baseline < 0 ? 'text-destructive' : 'text-money-income')}>
            {formatCurrency(terms.baseline)}/mo
          </strong>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Label htmlFor="forecast-override" className="text-xs text-muted-foreground">
            Manual baseline
          </Label>
          <Input
            id="forecast-override"
            inputMode="decimal"
            placeholder={String(Math.round(terms.baseline))}
            value={overrideText ?? ''}
            onChange={(e) => setOverrideText(e.target.value === '' ? null : e.target.value)}
            className="h-9 w-36 tabular-nums"
          />
          {!usingPlan && (
            <Button variant="ghost" size="sm" onClick={() => setOverrideText(null)}>
              Use plan
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {usingPlan ? 'Using the live plan value.' : 'Overridden — the forecast updates as you type.'}
          </span>
        </div>
      </div>

      {/* Horizon + headline stats */}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="forecast-horizon">Horizon (months)</Label>
          <Input
            id="forecast-horizon"
            type="number"
            inputMode="numeric"
            min={1}
            value={horizonText}
            onChange={(e) => setHorizonText(e.target.value)}
            className="h-9 w-28 tabular-nums"
          />
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <dt className="eyebrow mb-0.5">Starting net worth</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCurrency(startingNetWorth)}</dd>
          </div>
          <div>
            <dt className="eyebrow mb-0.5">Projected end</dt>
            <dd className={cn(
              'text-lg font-semibold tabular-nums',
              projection.endBalance < startingNetWorth ? 'text-destructive' : 'text-money-income',
            )}>
              {formatCurrency(projection.endBalance)}
            </dd>
          </div>
          <div>
            <dt className="eyebrow mb-0.5">Total change</dt>
            <dd className={cn(
              'text-lg font-semibold tabular-nums',
              projection.totalChange < 0 ? 'text-destructive' : 'text-money-income',
            )}>
              {projection.totalChange >= 0 ? '+' : ''}
              {formatCurrency(projection.totalChange)}
            </dd>
          </div>
        </dl>
      </div>

      {/* Chart */}
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={projection.months} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
              interval="preserveStartEnd"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={72}
              tick={{ fontSize: 12 }}
              tickFormatter={(v: number) => formatCurrency(v)}
            />
            <Tooltip
              contentStyle={chartTooltipStyle}
              itemStyle={chartTooltipItemStyle}
              labelStyle={chartTooltipLabelStyle}
              formatter={(value: number) => [formatCurrency(value), 'Net worth']}
            />
            <ReferenceLine y={startingNetWorth} stroke="hsl(var(--border))" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="endBalance"
              stroke={END_LINE}
              strokeWidth={2.5}
              dot={false}
              name="Net worth"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Adjustments */}
      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Adjustments</h3>
        </div>
        {adjustments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None — add one-time events (property tax, a bonus) or recurring changes (a raise)
            below.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {adjustments.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{a.name}</p>
                  <p className="text-xs text-muted-foreground">{adjustmentSubline(a)}</p>
                </div>
                <span
                  className={cn(
                    'text-sm font-semibold tabular-nums',
                    a.direction === 'income' ? 'text-money-income' : 'text-money-expense',
                  )}
                >
                  {a.direction === 'income' ? '+' : '−'}
                  {formatCurrency(Number(a.amount))}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (window.confirm(`Delete adjustment "${a.name}"?`)) {
                      toast.promise(deleteAdjustment.mutateAsync(a.id), {
                        loading: 'Deleting…',
                        success: 'Adjustment deleted',
                        error: 'Could not delete adjustment',
                      })
                    }
                  }}
                  aria-label={`Delete adjustment ${a.name}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AdjustmentForm />
      </div>

      {/* Month table */}
      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Month by month</h3>
        <div ref={scrollRef} className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Baseline</TableHead>
                <TableHead className="text-right">Adjustments</TableHead>
                <TableHead className="text-right">Net change</TableHead>
                <TableHead className="text-right">End balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projection.months.map((m) => (
                <TableRow key={m.month}>
                  <TableCell className="font-medium">{m.label}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatCurrency(m.baseline)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      m.adjustmentsTotal < 0 ? 'text-money-expense' : m.adjustmentsTotal > 0 ? 'text-money-income' : 'text-muted-foreground',
                    )}
                    title={m.adjustments.map((a) => `${a.name}: ${formatCurrency(a.signedAmount)}`).join('\n')}
                  >
                    {m.adjustmentsTotal === 0
                      ? '—'
                      : `${m.adjustmentsTotal > 0 ? '+' : '−'}${formatCurrency(Math.abs(m.adjustmentsTotal))}`}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-semibold tabular-nums',
                      m.netChange < 0 ? 'text-destructive' : 'text-money-income',
                    )}
                  >
                    {m.netChange >= 0 ? '+' : '−'}
                    {formatCurrency(Math.abs(m.netChange))}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatCurrency(m.endBalance)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  )
}

function adjustmentSubline(a: ForecastAdjustment): string {
  const monthOnly = (iso: string | null) => (iso ? iso.slice(0, 7) : '')
  if (a.kind === 'one_time') return `One-time · ${monthOnly(a.month)}`
  const from = a.start_month ? monthOnly(a.start_month) : '…'
  const to = a.end_month ? monthOnly(a.end_month) : '…'
  return `Recurring · ${from} → ${to}`
}

/** Add-adjustment form: name, income/spending, amount, one-time vs recurring. */
function AdjustmentForm() {
  const createAdjustment = useCreateForecastAdjustment()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [direction, setDirection] = useState<ForecastAdjustmentDirection>('spending')
  const [kind, setKind] = useState<ForecastAdjustmentKind>('one_time')
  const [amount, setAmount] = useState('')
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [startMonth, setStartMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [endMonth, setEndMonth] = useState('')

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-3" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" aria-hidden />
        Add adjustment
      </Button>
    )
  }

  const valid = name.trim() !== '' && Number(amount) > 0

  async function submit() {
    if (!valid) return
    const insert: ForecastAdjustmentInsert = {
      kind,
      direction,
      name: name.trim(),
      amount: Number(amount),
      ...(kind === 'one_time'
        ? { month: `${month}-01` }
        : {
            start_month: startMonth ? `${startMonth}-01` : null,
            end_month: endMonth ? `${endMonth}-01` : null,
          }),
    }
    try {
      await createAdjustment.mutateAsync(insert)
      toast.success(`Adjustment "${insert.name}" added`)
      setName('')
      setAmount('')
      setOpen(false)
    } catch {
      toast.error('Could not add adjustment')
    }
  }

  const monthInput = 'h-10 rounded-md border border-border bg-card px-3 text-sm text-foreground'

  return (
    <div className="mt-3 rounded-xl border border-border p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Property tax" />
        </div>
        <div className="space-y-1.5">
          <Label>Direction</Label>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as ForecastAdjustmentDirection)}
            className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground"
          >
            <option value="spending">Spending (−)</option>
            <option value="income">Income (+)</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Amount ($)</Label>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Type</Label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ForecastAdjustmentKind)}
            className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground"
          >
            <option value="one_time">One-time</option>
            <option value="recurring">Recurring</option>
          </select>
        </div>
        {kind === 'one_time' ? (
          <div className="space-y-1.5">
            <Label>Month</Label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className={monthInput}
            />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label>From (optional)</Label>
              <input
                type="month"
                value={startMonth}
                onChange={(e) => setStartMonth(e.target.value)}
                className={monthInput}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Through (optional)</Label>
              <input
                type="month"
                value={endMonth}
                onChange={(e) => setEndMonth(e.target.value)}
                className={monthInput}
              />
            </div>
          </>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={submit} disabled={!valid || createAdjustment.isPending}>
          {createAdjustment.isPending ? 'Adding…' : 'Add'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
