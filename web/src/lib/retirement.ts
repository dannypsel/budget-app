// Retirement projection — a pure client-side model (ProjectionLab-inspired
// but simpler): stacked account buckets, pre/post-retirement returns, yearly
// inflation of income + spending, and post-retirement withdrawals in the order
// taxable/cash → Traditional → Roth. No tax modeling beyond the Traditional
// gross-up (gross = needed ÷ (1 − tax rate)); Roth withdrawals are tax-free.

import type {
  RetirementAccountInput,
  RetirementInputs,
  RetirementTaxTreatment,
} from '@/types/domain'

export interface RetirementYearAccount {
  accountId: string
  name: string
  taxTreatment: RetirementTaxTreatment
  startBalance: number
  growth: number
  contributions: number
  oneTime: number
  withdrawals: number
  endBalance: number
}

export interface RetirementYear {
  year: number
  age: number
  preRetirement: boolean
  /** Nominal dollars that year. */
  income: number
  spending: number
  accounts: RetirementYearAccount[]
  totalStart: number
  totalEnd: number
  /** End balance expressed in today's dollars. */
  totalEndToday: number
  withdrawals: number
  estimatedTax: number
  /** Spending actually funded (nominal); < spending when shortfall. */
  netToSpending: number
  shortfall: boolean
}

export interface RetirementProjection {
  years: RetirementYear[]
  /** First age where spending can't be fully met; null = funded through the plan. */
  shortfallAge: number | null
  /** Last fully-funded age (planThroughAge when no shortfall). */
  fundedThroughAge: number
}

/** Client-generated id for a new account bucket / one-time addition. */
export function newRetirementRowId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newRetirementAccount(
  partial: Partial<RetirementAccountInput> = {},
): RetirementAccountInput {
  return {
    id: newRetirementRowId(),
    name: 'New account',
    balance: 0,
    annualContribution: 0,
    taxTreatment: 'taxable',
    returnOverridePct: null,
    ...partial,
  }
}

/** Seed buckets: Roth IRA, Traditional 401(k), taxable brokerage, HSA, cash. */
export function defaultRetirementAccounts(): RetirementAccountInput[] {
  return [
    newRetirementAccount({ name: 'Roth IRA', taxTreatment: 'roth' }),
    newRetirementAccount({ name: 'Traditional 401(k)', taxTreatment: 'traditional' }),
    newRetirementAccount({ name: 'Taxable brokerage', taxTreatment: 'taxable' }),
    newRetirementAccount({ name: 'HSA', taxTreatment: 'roth' }),
    newRetirementAccount({ name: 'Cash', taxTreatment: 'taxable' }),
  ]
}

export function defaultRetirementInputs(): RetirementInputs {
  return {
    currentAge: 35,
    retirementAge: 60,
    planThroughAge: 95,
    preRetirementReturnPct: 7,
    postRetirementReturnPct: 4,
    inflationPct: 3,
    preRetirementIncome: 150000,
    preRetirementSpending: 90000,
    postRetirementSpending: 75000,
    retirementTaxRatePct: 22,
    accounts: defaultRetirementAccounts(),
    oneTimes: [],
  }
}

/** "income − pre-retirement spending = $X/yr available to save" (today's dollars). */
export function availableToSavePerYear(inputs: RetirementInputs): number {
  return inputs.preRetirementIncome - inputs.preRetirementSpending
}

/** Withdrawal priority: taxable/cash first, then Traditional, then Roth. */
function withdrawalOrder(accounts: RetirementAccountInput[]): RetirementAccountInput[] {
  const rank: Record<RetirementTaxTreatment, number> = {
    taxable: 0,
    traditional: 1,
    roth: 2,
  }
  return [...accounts].sort((a, b) => rank[a.taxTreatment] - rank[b.taxTreatment])
}

/** First taxable/cash bucket, else the first bucket — where unassigned surplus
 *  (and gap-closing extra savings) land. Null when there are no buckets. */
function surplusAccount(accounts: RetirementAccountInput[]): RetirementAccountInput | null {
  return accounts.find((a) => a.taxTreatment === 'taxable') ?? accounts[0] ?? null
}

interface WithdrawalResult {
  taken: Map<string, number>
  tax: number
  unmet: number
}

/** Pull `need` (nominal) from balances in withdrawal order, mutating `balances`.
 *  Traditional withdrawals are grossed up: gross = needed ÷ (1 − taxRate), so
 *  the tax bite is estimated, not ignored. */
function withdrawFrom(
  balances: Map<string, number>,
  ordered: RetirementAccountInput[],
  need: number,
  taxRate: number,
): WithdrawalResult {
  const taken = new Map<string, number>()
  let tax = 0
  let remaining = need
  for (const acct of ordered) {
    if (remaining <= 0.005) break
    const bal = balances.get(acct.id) ?? 0
    if (bal <= 0) continue
    if (acct.taxTreatment === 'traditional') {
      const grossNeeded = taxRate >= 1 ? remaining : remaining / (1 - taxRate)
      const grossTaken = Math.min(grossNeeded, bal)
      const satisfied = grossTaken * (1 - taxRate)
      balances.set(acct.id, bal - grossTaken)
      taken.set(acct.id, (taken.get(acct.id) ?? 0) + grossTaken)
      tax += grossTaken - satisfied
      remaining -= satisfied
    } else {
      // taxable/cash and Roth both withdraw 1:1 (Roth is tax-free).
      const take = Math.min(remaining, bal)
      balances.set(acct.id, bal - take)
      taken.set(acct.id, (taken.get(acct.id) ?? 0) + take)
      remaining -= take
    }
  }
  return { taken, tax, unmet: Math.max(0, remaining) }
}

export interface ProjectRetirementOptions {
  /** Extra monthly savings during pre-retirement years, added on top of the
   *  modeled contributions (funded from outside the model — e.g. spending less).
   *  Used by the gap-closing bisection. */
  extraMonthlySavings?: number
  /** Calendar year the projection starts on (defaults to the current year). */
  startYear?: number
}

export function projectRetirement(
  inputs: RetirementInputs,
  opts: ProjectRetirementOptions = {},
): RetirementProjection {
  const startYear = opts.startYear ?? new Date().getFullYear()
  const extraMonthly = Math.max(0, opts.extraMonthlySavings ?? 0)
  const inflation = 1 + inputs.inflationPct / 100
  const taxRate = Math.min(0.99, Math.max(0, inputs.retirementTaxRatePct / 100))
  const ordered = withdrawalOrder(inputs.accounts)
  const surplusAcct = surplusAccount(inputs.accounts)

  const balances = new Map<string, number>(
    inputs.accounts.map((a) => [a.id, Math.max(0, a.balance)]),
  )

  const years: RetirementYear[] = []
  let shortfallAge: number | null = null

  for (let age = inputs.currentAge; age <= inputs.planThroughAge; age++) {
    const t = age - inputs.currentAge
    const year = startYear + t
    const infl = Math.pow(inflation, t)
    const pre = age < inputs.retirementAge
    const defaultReturn = (pre ? inputs.preRetirementReturnPct : inputs.postRetirementReturnPct) / 100

    const rows: RetirementYearAccount[] = []
    const startBalances = new Map<string, number>()
    for (const acct of inputs.accounts) {
      const start = balances.get(acct.id) ?? 0
      startBalances.set(acct.id, start)
      const r = acct.returnOverridePct != null ? acct.returnOverridePct / 100 : defaultReturn
      const growth = start * r
      // Contributions are pre-retirement only; one-time additions follow their
      // configured year.
      const contribution = pre ? Math.max(0, acct.annualContribution) * infl : 0
      const oneTime = inputs.oneTimes
        .filter((o) => o.year === year && o.accountId === acct.id)
        .reduce((s, o) => s + Math.max(0, o.amount), 0)
      const afterGrowth = start + growth + contribution + oneTime
      balances.set(acct.id, afterGrowth)
      rows.push({
        accountId: acct.id,
        name: acct.name,
        taxTreatment: acct.taxTreatment,
        startBalance: start,
        growth,
        contributions: contribution,
        oneTime,
        withdrawals: 0,
        endBalance: afterGrowth,
      })
    }
    const totalContributions = rows.reduce((s, r) => s + r.contributions, 0)

    const income = pre ? inputs.preRetirementIncome * infl : 0
    const spending = (pre ? inputs.preRetirementSpending : inputs.postRetirementSpending) * infl

    let withdrawals = 0
    let estimatedTax = 0
    let unmet = 0
    const takenByAccount = new Map<string, number>()

    if (pre) {
      // Unassigned surplus lands in the first taxable/cash bucket; a deficit is
      // pulled back out of the buckets in withdrawal order.
      const surplus = income - spending - totalContributions
      if (surplusAcct) {
        if (surplus >= 0) {
          balances.set(surplusAcct.id, (balances.get(surplusAcct.id) ?? 0) + surplus)
        } else {
          const res = withdrawFrom(balances, ordered, -surplus, taxRate)
          withdrawals = [...res.taken.values()].reduce((s, v) => s + v, 0)
          estimatedTax = res.tax
          unmet = res.unmet
          for (const [id, v] of res.taken) takenByAccount.set(id, v)
        }
      }
      if (extraMonthly > 0 && surplusAcct) {
        balances.set(surplusAcct.id, (balances.get(surplusAcct.id) ?? 0) + extraMonthly * 12)
      }
    } else {
      const res = withdrawFrom(balances, ordered, spending, taxRate)
      withdrawals = [...res.taken.values()].reduce((s, v) => s + v, 0)
      estimatedTax = res.tax
      unmet = res.unmet
      for (const [id, v] of res.taken) takenByAccount.set(id, v)
    }

    for (const row of rows) {
      row.withdrawals = takenByAccount.get(row.accountId) ?? 0
      row.endBalance = balances.get(row.accountId) ?? 0
    }
    const totalStart = rows.reduce((s, r) => s + r.startBalance, 0)
    const totalEnd = rows.reduce((s, r) => s + r.endBalance, 0)

    const shortfall = unmet > 0.005
    if (shortfall && shortfallAge == null) shortfallAge = age

    years.push({
      year,
      age,
      preRetirement: pre,
      income,
      spending,
      accounts: rows,
      totalStart,
      totalEnd,
      totalEndToday: infl > 0 ? totalEnd / infl : totalEnd,
      withdrawals,
      estimatedTax,
      netToSpending: spending - unmet,
      shortfall,
    })

    if (shortfall) break
  }

  // Fix up per-account withdrawal attribution: we know the total withdrawn and
  // the tax, but not the split. Re-derive it by replaying each year's
  // withdrawals against that year's start-of-withdrawal balances is overkill
  // for the UI — instead attribute withdrawals to accounts in withdrawal order
  // from the year's recorded balances. Simpler: recompute inside the loop.
  return {
    years,
    shortfallAge,
    fundedThroughAge: shortfallAge != null ? shortfallAge - 1 : inputs.planThroughAge,
  }
}

/**
 * Extra monthly pre-retirement savings needed to close the funding gap, via
 * bisection. Returns 0 when no extra savings are needed, null when the gap
 * can't be closed (even at the cap). Whole dollars.
 */
export function extraMonthlySavingsToCloseGap(inputs: RetirementInputs): number | null {
  if (projectRetirement(inputs).shortfallAge == null) return 0
  const CAP = 100000 // $/month — beyond this the answer isn't actionable anyway
  if (projectRetirement(inputs, { extraMonthlySavings: CAP }).shortfallAge != null) {
    return null
  }
  let lo = 0
  let hi = CAP
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (projectRetirement(inputs, { extraMonthlySavings: mid }).shortfallAge == null) {
      hi = mid
    } else {
      lo = mid
    }
  }
  return Math.ceil(hi)
}
