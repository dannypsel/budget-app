// Retirement — a client-side what-if projection (ProjectionLab-inspired, no tax
// modeling beyond the Traditional gross-up). Stacked annual bars per account
// bucket; click a year to drill into per-account detail. Named scenarios save
// to retirement_scenarios and can be compared side by side.

import { useMemo, useRef, useState } from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Pencil, Plus, Trash2 } from 'lucide-react'
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
  useCreateRetirementScenario,
  useDeleteRetirementScenario,
  useRetirementScenarios,
  useUpdateRetirementScenario,
} from '@/data/hooks'
import {
  availableToSavePerYear,
  bucketTotalsForYear,
  defaultRetirementInputs,
  extraMonthlySavingsToCloseGap,
  newRetirementAccount,
  newRetirementRowId,
  projectRetirement,
  projectRetirementBands,
  RETIREMENT_BUCKETS,
  RETIREMENT_BUCKET_COLORS,
  type RetirementProjection,
  type RetirementYear,
} from '@/lib/retirement'
import {
  chartTooltipItemStyle,
  chartTooltipLabelStyle,
  chartTooltipStyle,
} from '@/lib/chartTooltip'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'
import type {
  RetirementAccountInput,
  RetirementInputs,
  RetirementOneTime,
  RetirementScenario,
  RetirementTaxTreatment,
} from '@/types/domain'

const TAX_TREATMENTS: Array<{ value: RetirementTaxTreatment; label: string }> = [
  { value: 'taxable', label: 'Taxable / cash' },
  { value: 'traditional', label: 'Traditional (pre-tax)' },
  { value: 'roth', label: 'Roth (tax-free)' },
]

export default function RetirementPage() {
  const [inputs, setInputs] = useState<RetirementInputs>(() => defaultRetirementInputs())
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const [scenarioName, setScenarioName] = useState('')
  const [compareA, setCompareA] = useState('')
  const [compareB, setCompareB] = useState('')

  const { data: scenarios = [], isLoading: scenariosLoading } = useRetirementScenarios()
  const createScenario = useCreateRetirementScenario()
  const updateScenario = useUpdateRetirementScenario()
  const deleteScenario = useDeleteRetirementScenario()

  const projection = useMemo(() => projectRetirement(inputs), [inputs])
  const gapMonthly = useMemo(() => extraMonthlySavingsToCloseGap(inputs), [inputs])
  const savePerYear = availableToSavePerYear(inputs)

  const set = <K extends keyof RetirementInputs>(key: K, value: RetirementInputs[K]) =>
    setInputs((prev) => ({ ...prev, [key]: value }))

  const patchAccount = (id: string, patch: Partial<RetirementAccountInput>) =>
    setInputs((prev) => ({
      ...prev,
      accounts: prev.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }))

  const selected = selectedYear != null ? projection.years.find((y) => y.year === selectedYear) ?? null : null

  async function saveScenario() {
    const name = scenarioName.trim()
    if (!name) {
      toast.error('Give the scenario a name.')
      return
    }
    await createScenario.mutateAsync({ name, inputs })
    toast.success(`Scenario "${name}" saved`)
    setScenarioName('')
  }

  function loadScenario(s: RetirementScenario) {
    // Deep-clone so editing the loaded model never mutates the saved JSON.
    setInputs(JSON.parse(JSON.stringify(s.inputs)) as RetirementInputs)
    setSelectedYear(null)
    toast.success(`Loaded "${s.name}"`)
  }

  const scenarioA = scenarios.find((s) => s.id === compareA) ?? null
  const scenarioB = scenarios.find((s) => s.id === compareB) ?? null
  const comparing = scenarioA != null && scenarioB != null

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Retirement</h1>
        <div className="flex items-center gap-2">
          <Input
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            placeholder="Scenario name"
            className="h-9 w-44"
            aria-label="Scenario name"
          />
          <Button size="sm" onClick={saveScenario} disabled={createScenario.isPending}>
            {createScenario.isPending ? 'Saving…' : 'Save scenario'}
          </Button>
        </div>
      </div>

      {/* Saved scenarios */}
      <section className="card-surface p-4 md:p-6">
        <h2 className="eyebrow mb-3">Saved scenarios</h2>
        {scenariosLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : scenarios.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved scenarios yet — tune the model below and save it with a name.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {scenarios.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{s.name}</p>
                  <ScenarioSubline inputs={s.inputs} />
                </div>
                <Button variant="outline" size="sm" onClick={() => loadScenario(s)}>
                  Load
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Overwrite "${s.name}" with the current inputs?`)) {
                      toast.promise(updateScenario.mutateAsync({ id: s.id, patch: { inputs } }), {
                        loading: 'Saving…',
                        success: `"${s.name}" updated`,
                        error: 'Could not update scenario',
                      })
                    }
                  }}
                  disabled={updateScenario.isPending}
                >
                  <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Overwrite
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (window.confirm(`Delete scenario "${s.name}"?`)) {
                      toast.promise(deleteScenario.mutateAsync(s.id), {
                        loading: 'Deleting…',
                        success: `"${s.name}" deleted`,
                        error: 'Could not delete scenario',
                      })
                    }
                  }}
                  aria-label={`Delete scenario ${s.name}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Inputs */}
      <section className="card-surface p-4 md:p-6">
        <h2 className="eyebrow mb-4">Assumptions</h2>
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <NumField label="Current age" value={inputs.currentAge} min={18} max={80} onChange={(v) => set('currentAge', Math.round(v))} />
          <NumField label="Retirement age" value={inputs.retirementAge} min={30} max={80} onChange={(v) => set('retirementAge', Math.round(v))} />
          <NumField label="Plan through age" value={inputs.planThroughAge} min={70} max={110} onChange={(v) => set('planThroughAge', Math.round(v))} />
          <NumField label="Pre-retirement return %" value={inputs.preRetirementReturnPct} min={0} max={15} step={0.1} onChange={(v) => set('preRetirementReturnPct', v)} />
          <NumField label="Post-retirement return %" value={inputs.postRetirementReturnPct} min={0} max={15} step={0.1} onChange={(v) => set('postRetirementReturnPct', v)} />
          <NumField label="Inflation %" value={inputs.inflationPct} min={0} max={10} step={0.1} onChange={(v) => set('inflationPct', v)} />
          <NumField label="Expected retirement tax rate %" value={inputs.retirementTaxRatePct} min={0} max={50} step={0.5} onChange={(v) => set('retirementTaxRatePct', v)} />
          <NumField label="Annual income before retirement" value={inputs.preRetirementIncome} min={0} max={2000000} step={1000} money onChange={(v) => set('preRetirementIncome', v)} />
          <NumField label="Annual spending before retirement" value={inputs.preRetirementSpending} min={0} max={1000000} step={1000} money onChange={(v) => set('preRetirementSpending', v)} />
          <NumField label="Annual spending after retirement" value={inputs.postRetirementSpending} min={0} max={1000000} step={1000} money onChange={(v) => set('postRetirementSpending', v)} />
        </div>
        <p className="mt-4 rounded-lg bg-surface-container-low px-3 py-2 text-sm text-foreground">
          {formatCurrency(inputs.preRetirementIncome)} − {formatCurrency(inputs.preRetirementSpending)}{' '}
          = <strong className={cn('tabular-nums', savePerYear < 0 && 'text-destructive')}>
            {formatCurrency(savePerYear)}/yr
          </strong>{' '}
          available to save
          <span className="text-muted-foreground"> (today's dollars; spending inputs inflate yearly)</span>
        </p>
      </section>

      {/* Account buckets */}
      <section className="card-surface p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="eyebrow">Account buckets</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setInputs((prev) => ({ ...prev, accounts: [...prev.accounts, newRetirementAccount()] }))
            }
          >
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Add account
          </Button>
        </div>
        {inputs.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts — add one to model.</p>
        ) : (
          <ul className="space-y-3">
            {inputs.accounts.map((a) => (
              <li key={a.id} className="rounded-xl border border-border p-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
                  <div className="space-y-1.5 lg:col-span-2">
                    <Label>Name</Label>
                    <Input value={a.name} onChange={(e) => patchAccount(a.id, { name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Balance ($)</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={a.balance}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (Number.isFinite(n)) patchAccount(a.id, { balance: n })
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Annual contribution ($)</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={a.annualContribution}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (Number.isFinite(n)) patchAccount(a.id, { annualContribution: n })
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Tax treatment</Label>
                    <select
                      value={a.taxTreatment}
                      onChange={(e) => patchAccount(a.id, { taxTreatment: e.target.value as RetirementTaxTreatment })}
                      className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    >
                      {TAX_TREATMENTS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1.5">
                      <Label>Return % override</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        placeholder="auto"
                        value={a.returnOverridePct ?? ''}
                        onChange={(e) => {
                          const t = e.target.value
                          patchAccount(a.id, {
                            returnOverridePct: t.trim() === '' ? null : Number(t),
                          })
                        }}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setInputs((prev) => ({
                          ...prev,
                          accounts: prev.accounts.filter((x) => x.id !== a.id),
                          oneTimes: prev.oneTimes.filter((o) => o.accountId !== a.id),
                        }))
                      }
                      aria-label={`Remove ${a.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* One-time additions */}
      <section className="card-surface p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="eyebrow">One-time additions</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={inputs.accounts.length === 0}
            onClick={() =>
              setInputs((prev) => ({
                ...prev,
                oneTimes: [
                  ...prev.oneTimes,
                  {
                    id: newRetirementRowId(),
                    amount: 0,
                    year: new Date().getFullYear(),
                    accountId: prev.accounts[0]?.id ?? '',
                  },
                ],
              }))
            }
          >
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Add
          </Button>
        </div>
        {inputs.oneTimes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None — add a windfall, inheritance, or lump-sum contribution in a given year.
          </p>
        ) : (
          <ul className="space-y-3">
            {inputs.oneTimes.map((o) => (
              <li key={o.id} className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-4">
                <div className="space-y-1.5">
                  <Label>Amount ($)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    className="w-36"
                    value={o.amount}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patchOneTime(o.id, { amount: n })
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Year</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    className="w-28"
                    value={o.year}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value))
                      if (Number.isFinite(n)) patchOneTime(o.id, { year: n })
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Account</Label>
                  <select
                    value={o.accountId}
                    onChange={(e) => patchOneTime(o.id, { accountId: e.target.value })}
                    className="h-10 rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  >
                    {inputs.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    setInputs((prev) => ({ ...prev, oneTimes: prev.oneTimes.filter((x) => x.id !== o.id) }))
                  }
                  aria-label="Remove one-time addition"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Verdict */}
      <section className="card-surface p-4 md:p-6">
        {projection.shortfallAge != null ? (
          <div>
            <h2 className="text-xl font-semibold text-destructive">
              Funds run out at age {projection.shortfallAge}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {gapMonthly == null ? (
                'Even maximum modeled savings cannot close this gap — lower spending or raise returns.'
              ) : gapMonthly === 0 ? (
                'No extra savings needed.'
              ) : (
                <>
                  Save an extra{' '}
                  <strong className="tabular-nums text-foreground">{formatCurrency(gapMonthly)}/mo</strong>{' '}
                  before retirement to stay funded through age {inputs.planThroughAge}.
                </>
              )}
            </p>
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-semibold text-money-income">
              Funded through age {inputs.planThroughAge}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ending balance {formatCurrency(lastYear(projection).totalEnd)} nominal ·{' '}
              {formatCurrency(lastYear(projection).totalEndToday)} in today's dollars ·{' '}
              <strong className="text-foreground">
                {formatCurrency(lastYear(projection).afterTaxTotalEndToday)} after tax
              </strong>{' '}
              in today's dollars.
            </p>
          </div>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4 sm:grid-cols-4">
          <Stat label="Starting balance" value={formatCurrency(projection.years[0]?.totalStart ?? 0)} />
          <Stat
            label={`At retirement (age ${inputs.retirementAge})`}
            value={formatCurrency(balanceAtRetirement(projection))}
          />
          <Stat label="Total contributions" value={formatCurrency(totalContributions(projection))} />
          <Stat label="Total withdrawn" value={formatCurrency(totalWithdrawn(projection))} />
        </dl>
      </section>

      {/* Hero chart */}
      <section className="card-surface p-4 md:p-6">
        <h2 className="eyebrow mb-4">Projected balance by bucket — click a year for detail</h2>
        <ProjectionChart
          projection={projection}
          accounts={inputs.accounts}
          selectedYear={selectedYear}
          onSelectYear={setSelectedYear}
        />
      </section>

      {/* Outcome band */}
      <OutcomeRange inputs={inputs} />

      {/* Year detail */}
      {selected && <YearDetail year={selected} />}

      {/* Compare */}
      <section className="card-surface p-4 md:p-6">
        <h2 className="eyebrow mb-4">Compare scenarios</h2>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label>Scenario A</Label>
            <select
              value={compareA}
              onChange={(e) => setCompareA(e.target.value)}
              className="h-10 min-w-48 rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">Choose…</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Scenario B</Label>
            <select
              value={compareB}
              onChange={(e) => setCompareB(e.target.value)}
              className="h-10 min-w-48 rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">Choose…</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {comparing && <ScenarioCompare a={scenarioA} b={scenarioB} />}
      </section>
    </div>
  )

  function patchOneTime(id: string, patch: Partial<RetirementOneTime>) {
    setInputs((prev) => ({
      ...prev,
      oneTimes: prev.oneTimes.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    }))
  }
}

function lastYear(p: RetirementProjection): RetirementYear {
  return p.years[p.years.length - 1]
}

/** Balance at the end of the last pre-retirement year (starting balance when
 *  already retired). */
function balanceAtRetirement(p: RetirementProjection): number {
  const pre = p.years.filter((y) => y.preRetirement)
  if (pre.length === 0) return p.years[0]?.totalStart ?? 0
  return pre[pre.length - 1].totalEnd
}

function totalContributions(p: RetirementProjection): number {
  return p.years.reduce(
    (s, y) => s + y.accounts.reduce((a, r) => a + r.contributions + r.oneTime, 0),
    0,
  )
}

function totalWithdrawn(p: RetirementProjection): number {
  return p.years.reduce((s, y) => s + y.withdrawals, 0)
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow mb-0.5">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

function ScenarioSubline({ inputs }: { inputs: RetirementInputs }) {
  const p = useMemo(() => projectRetirement(inputs), [inputs])
  return (
    <p className="text-xs text-muted-foreground">
      Retire at {inputs.retirementAge} ·{' '}
      {p.shortfallAge != null ? (
        <span className="text-destructive">runs out at {p.shortfallAge}</span>
      ) : (
        <span className="text-money-income">funded through {inputs.planThroughAge}</span>
      )}{' '}
      · ends {formatCurrency(lastYear(p).totalEndToday)} today$
    </p>
  )
}

/** Numeric type-in box synced two-way with a slider. */
function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  money = false,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  money?: boolean
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  // While the user is typing, don't stomp their text; otherwise mirror the value
  // (slider moves, scenario loads). Adjusted during render (React's documented
  // pattern for this), not in an effect.
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    if (!focused) setText(String(value))
  }

  const commitText = (t: string) => {
    setText(t)
    const n = Number(t)
    if (t.trim() !== '' && Number.isFinite(n)) onChange(n)
  }
  const fromSlider = (n: number) => {
    setText(String(n))
    onChange(n)
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-3">
        <Input
          type="number"
          inputMode="decimal"
          value={text}
          onChange={(e) => commitText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            setText(String(value))
          }}
          className={cn('tabular-nums', money ? 'w-32' : 'w-24')}
          aria-label={label}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Math.min(max, Math.max(min, value))}
          onChange={(e) => fromSlider(Number(e.target.value))}
          className="h-2 flex-1 cursor-pointer accent-primary"
          aria-label={`${label} slider`}
        />
      </div>
    </div>
  )
}

/** Stacked annual bars per canonical bucket (Roth / Traditional / Taxable /
 *  HSA / Cash — accounts aggregate into their bucket). Clicking a year
 *  selects it. The tooltip shows each bucket's balance and that year's
 *  contributions into it. */
function ProjectionChart({
  projection,
  onSelectYear,
}: {
  projection: RetirementProjection
  accounts?: RetirementAccountInput[]
  selectedYear: number | null
  onSelectYear: (year: number) => void
}) {
  const data = useMemo(
    () =>
      projection.years.map((y) => {
        const row: Record<string, number> = { year: y.year, age: y.age }
        for (const [bucket, totals] of bucketTotalsForYear(y)) {
          row[bucket] = totals.balance
          row[`${bucket}Contributions`] = totals.contributions
        }
        return row
      }),
    [projection],
  )
  const presentBuckets = useMemo(
    () =>
      RETIREMENT_BUCKETS.filter((b) => data.some((row) => (row[b] ?? 0) > 0)),
    [data],
  )

  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Nothing to project.</p>
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart
        data={data}
        margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        onClick={(s: unknown) => {
          const label = (s as { activeLabel?: unknown } | null)?.activeLabel
          if (typeof label === 'number') onSelectYear(label)
        }}
        className="cursor-pointer"
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="year"
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
          formatter={(value: number, name: string, item: { payload?: Record<string, number> }) => {
            const contrib = item?.payload?.[`${name}Contributions`]
            return [
              contrib != null && contrib > 0
                ? `${formatCurrency(value)} · +${formatCurrency(contrib)} contributed`
                : formatCurrency(value),
              name,
            ]
          }}
          labelFormatter={(year: number) => {
            const y = projection.years.find((yy) => yy.year === year)
            return y ? `${year} · age ${y.age}${y.preRetirement ? '' : ' · retired'}` : String(year)
          }}
        />
        {presentBuckets.map((b) => (
          <Bar
            key={b}
            dataKey={b}
            name={b}
            stackId="total"
            fill={RETIREMENT_BUCKET_COLORS[b]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Best / expected / worst outcome band — deterministic offsets (returns
 *  ±2pts, inflation ∓1pt), NOT Monte Carlo. Plots the after-tax balance in
 *  today's dollars so the band reads in spendable terms. */
function OutcomeRange({ inputs }: { inputs: RetirementInputs }) {
  const bands = useMemo(() => projectRetirementBands(inputs), [inputs])
  const data = useMemo(() => {
    const len = Math.max(
      bands.worst.years.length,
      bands.expected.years.length,
      bands.best.years.length,
    )
    const at = (p: RetirementProjection, i: number) =>
      p.years[Math.min(i, p.years.length - 1)]?.afterTaxTotalEndToday ?? 0
    return Array.from({ length: len }, (_, i) => {
      const expected = at(bands.expected, i)
      const worst = at(bands.worst, i)
      const best = at(bands.best, i)
      const yearRow =
        bands.expected.years[Math.min(i, bands.expected.years.length - 1)]
      return {
        year: yearRow?.year ?? 0,
        age: yearRow?.age ?? 0,
        range: [Math.min(worst, best), Math.max(worst, best)] as [number, number],
        expected,
        worst,
        best,
      }
    })
  }, [bands])

  const chip = (label: string, p: RetirementProjection) => {
    const last = p.years[p.years.length - 1]
    return (
      <div key={label}>
        <dt className="eyebrow mb-0.5">{label}</dt>
        <dd className="text-lg font-semibold tabular-nums text-foreground">
          {last ? formatCurrency(last.afterTaxTotalEndToday) : '—'}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {p.shortfallAge != null ? `runs out at ${p.shortfallAge}` : `funded through ${inputs.planThroughAge}`}
          </span>
        </dd>
      </div>
    )
  }

  return (
    <section className="card-surface p-4 md:p-6">
      <h2 className="eyebrow mb-1">Outcome range — best / expected / worst</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Same plan at returns ±2pts and inflation ∓1pt. After-tax balances in today's dollars.
      </p>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="year"
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
            formatter={(value: number | [number, number], name: string) => {
              if (name === 'range' && Array.isArray(value)) {
                return [`${formatCurrency(value[0])} – ${formatCurrency(value[1])}`, 'Worst – Best']
              }
              return [formatCurrency(value as number), 'Expected']
            }}
            labelFormatter={(year: number) => {
              const row = data.find((d) => d.year === year)
              return row ? `${year} · age ${row.age}` : String(year)
            }}
          />
          <Area dataKey="range" name="range" stroke="none" fill="#3b82f6" fillOpacity={0.18} />
          <Line
            dataKey="expected"
            name="expected"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <dl className="mt-4 grid grid-cols-1 gap-4 border-t border-outline-variant/30 pt-4 sm:grid-cols-3">
        {chip('Worst', bands.worst)}
        {chip('Expected', bands.expected)}
        {chip('Best', bands.best)}
      </dl>
    </section>
  )
}

/** Per-account drill-down for one projection year. */
function YearDetail({ year }: { year: RetirementYear }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(scrollRef)
  return (
    <section className="card-surface p-4 md:p-6">
      <h2 className="eyebrow mb-1">
        {year.year} · age {year.age} {year.preRetirement ? '' : '· retired'}
      </h2>
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <span className="text-muted-foreground">
          Spending{' '}
          <strong className="tabular-nums text-foreground">{formatCurrency(year.spending)}</strong>
        </span>
        <span className="text-muted-foreground">
          Net to spending{' '}
          <strong className="tabular-nums text-foreground">{formatCurrency(year.netToSpending)}</strong>
        </span>
        <span className="text-muted-foreground">
          Estimated tax{' '}
          <strong className="tabular-nums text-foreground">{formatCurrency(year.estimatedTax)}</strong>
        </span>
        <span className="text-muted-foreground">
          Total{' '}
          <strong className="tabular-nums text-foreground">{formatCurrency(year.totalEnd)}</strong>
          <span className="text-muted-foreground"> · {formatCurrency(year.totalEndToday)} today$</span>
        </span>
        <span className="text-muted-foreground">
          After tax{' '}
          <strong className="tabular-nums text-foreground">{formatCurrency(year.afterTaxTotalEnd)}</strong>
          <span className="text-muted-foreground"> · {formatCurrency(year.afterTaxTotalEndToday)} today$</span>
        </span>
        {year.shortfall && (
          <span className="font-semibold text-destructive">Shortfall this year</span>
        )}
      </div>
      <div ref={scrollRef} className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="text-right">Contributions</TableHead>
              <TableHead className="text-right">Growth</TableHead>
              <TableHead className="text-right">Withdrawals</TableHead>
              <TableHead className="text-right">End balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {year.accounts.map((a) => (
              <TableRow key={a.accountId}>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(a.startBalance)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(a.contributions + a.oneTime)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-money-income">
                  {formatCurrency(a.growth)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-money-expense">
                  {a.withdrawals > 0 ? formatCurrency(a.withdrawals) : '—'}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatCurrency(a.endBalance)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

interface CompareStats {
  name: string
  starting: number
  atRetirement: number
  verdict: string
  verdictBad: boolean
  endNominal: number
  endToday: number
  endAfterTaxToday: number
  contributions: number
  gapMonthly: number | null
}

function statsFor(s: RetirementScenario): CompareStats {
  const p = projectRetirement(s.inputs)
  const last = lastYear(p)
  return {
    name: s.name,
    starting: p.years[0]?.totalStart ?? 0,
    atRetirement: balanceAtRetirement(p),
    verdict:
      p.shortfallAge != null
        ? `Runs out at ${p.shortfallAge}`
        : `Funded through ${s.inputs.planThroughAge}`,
    verdictBad: p.shortfallAge != null,
    endNominal: last.totalEnd,
    endToday: last.totalEndToday,
    endAfterTaxToday: last.afterTaxTotalEndToday,
    contributions: totalContributions(p),
    gapMonthly: extraMonthlySavingsToCloseGap(s.inputs),
  }
}

/** Side-by-side comparison of two saved scenarios. */
function ScenarioCompare({ a, b }: { a: RetirementScenario; b: RetirementScenario }) {
  const sa = useMemo(() => statsFor(a), [a])
  const sb = useMemo(() => statsFor(b), [b])
  const projA = useMemo(() => projectRetirement(a.inputs), [a])
  const projB = useMemo(() => projectRetirement(b.inputs), [b])
  const scrollRef = useRef<HTMLDivElement>(null)
  useHorizontalWheel(scrollRef)

  const rows: Array<{ label: string; fa: (s: CompareStats) => string; bad?: (s: CompareStats) => boolean }> = [
    { label: 'Starting balance', fa: (s) => formatCurrency(s.starting) },
    { label: 'At retirement', fa: (s) => formatCurrency(s.atRetirement) },
    { label: 'Verdict', fa: (s) => s.verdict, bad: (s) => s.verdictBad },
    { label: 'Ending balance (nominal)', fa: (s) => formatCurrency(s.endNominal) },
    { label: "Ending balance (today's $)", fa: (s) => formatCurrency(s.endToday) },
    { label: "Ending balance (after tax, today's $)", fa: (s) => formatCurrency(s.endAfterTaxToday) },
    { label: 'Total contributions', fa: (s) => formatCurrency(s.contributions) },
    {
      label: 'Extra/mo to close gap',
      fa: (s) =>
        s.gapMonthly == null ? 'Unclosable' : s.gapMonthly === 0 ? '—' : formatCurrency(s.gapMonthly),
      bad: (s) => s.gapMonthly != null && s.gapMonthly > 0,
    },
  ]

  return (
    <div className="mt-4">
      <div ref={scrollRef} className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-label="Metric" />
              <TableHead>{sa.name}</TableHead>
              <TableHead>{sb.name}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="font-medium text-muted-foreground">{r.label}</TableCell>
                <TableCell className={cn('tabular-nums', r.bad?.(sa) && 'font-semibold text-destructive')}>
                  {r.fa(sa)}
                </TableCell>
                <TableCell className={cn('tabular-nums', r.bad?.(sb) && 'font-semibold text-destructive')}>
                  {r.fa(sb)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground">{sa.name}</h3>
          <ProjectionChart
            projection={projA}
            accounts={a.inputs.accounts}
            selectedYear={null}
            onSelectYear={() => {}}
          />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground">{sb.name}</h3>
          <ProjectionChart
            projection={projB}
            accounts={b.inputs.accounts}
            selectedYear={null}
            onSelectYear={() => {}}
          />
        </div>
      </div>
    </div>
  )
}
