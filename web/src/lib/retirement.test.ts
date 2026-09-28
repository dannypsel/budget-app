import { describe, expect, it } from 'vitest'
import {
  availableToSavePerYear,
  defaultRetirementInputs,
  extraMonthlySavingsToCloseGap,
  newRetirementAccount,
  projectRetirement,
} from './retirement'
import type { RetirementInputs } from '@/types/domain'

function inputs(partial: Partial<RetirementInputs>): RetirementInputs {
  return {
    ...defaultRetirementInputs(),
    accounts: [],
    oneTimes: [],
    inflationPct: 0,
    ...partial,
  }
}

const START = 2026

describe('projectRetirement', () => {
  it('grows a single account at the pre-retirement return with no flows', () => {
    const p = projectRetirement(
      inputs({
        currentAge: 40,
        planThroughAge: 40,
        preRetirementReturnPct: 10,
        preRetirementIncome: 0,
        preRetirementSpending: 0,
        accounts: [newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 10000 })],
      }),
      { startYear: START },
    )
    expect(p.years).toHaveLength(1)
    expect(p.years[0].totalEnd).toBeCloseTo(11000, 6)
    expect(p.shortfallAge).toBeNull()
    expect(p.fundedThroughAge).toBe(40)
  })

  it('withdraws taxable first, leaving traditional and roth untouched', () => {
    const p = projectRetirement(
      inputs({
        currentAge: 65,
        retirementAge: 60, // already retired
        planThroughAge: 65,
        postRetirementReturnPct: 0,
        postRetirementSpending: 800,
        retirementTaxRatePct: 25,
        accounts: [
          newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 1000 }),
          newRetirementAccount({ name: 'Trad', taxTreatment: 'traditional', balance: 10000 }),
          newRetirementAccount({ name: 'Roth', taxTreatment: 'roth', balance: 10000 }),
        ],
      }),
      { startYear: START },
    )
    const y = p.years[0]
    expect(y.preRetirement).toBe(false)
    const byName = new Map(y.accounts.map((a) => [a.name, a]))
    expect(byName.get('Tax')!.withdrawals).toBeCloseTo(800, 6)
    expect(byName.get('Tax')!.endBalance).toBeCloseTo(200, 6)
    expect(byName.get('Trad')!.withdrawals).toBe(0)
    expect(byName.get('Roth')!.withdrawals).toBe(0)
    expect(y.estimatedTax).toBe(0)
    expect(y.netToSpending).toBeCloseTo(800, 6)
  })

  it('grosses up traditional withdrawals for tax', () => {
    const p = projectRetirement(
      inputs({
        currentAge: 65,
        retirementAge: 60,
        planThroughAge: 65,
        postRetirementReturnPct: 0,
        postRetirementSpending: 750,
        retirementTaxRatePct: 25,
        accounts: [newRetirementAccount({ name: 'Trad', taxTreatment: 'traditional', balance: 10000 })],
      }),
      { startYear: START },
    )
    const y = p.years[0]
    const trad = y.accounts[0]
    // Need $750 net at 25% tax → $1000 gross withdrawn, $250 estimated tax.
    expect(trad.withdrawals).toBeCloseTo(1000, 6)
    expect(trad.endBalance).toBeCloseTo(9000, 6)
    expect(y.estimatedTax).toBeCloseTo(250, 6)
    expect(y.netToSpending).toBeCloseTo(750, 6)
  })

  it('roth withdrawals are tax-free', () => {
    const p = projectRetirement(
      inputs({
        currentAge: 65,
        retirementAge: 60,
        planThroughAge: 65,
        postRetirementReturnPct: 0,
        postRetirementSpending: 500,
        retirementTaxRatePct: 25,
        accounts: [newRetirementAccount({ name: 'Roth', taxTreatment: 'roth', balance: 2000 })],
      }),
      { startYear: START },
    )
    const y = p.years[0]
    expect(y.accounts[0].withdrawals).toBeCloseTo(500, 6)
    expect(y.estimatedTax).toBe(0)
  })

  it('adds unassigned pre-retirement surplus to the first taxable account', () => {
    const p = projectRetirement(
      inputs({
        currentAge: 40,
        planThroughAge: 40,
        preRetirementReturnPct: 0,
        preRetirementIncome: 100000,
        preRetirementSpending: 60000,
        accounts: [
          newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 0, annualContribution: 10000 }),
          newRetirementAccount({ name: 'Roth', taxTreatment: 'roth', balance: 0, annualContribution: 5000 }),
        ],
      }),
      { startYear: START },
    )
    const byName = new Map(p.years[0].accounts.map((a) => [a.name, a]))
    // surplus = 100000 − 60000 − 15000 = 25000 → Tax
    expect(byName.get('Tax')!.contributions).toBeCloseTo(10000, 6)
    expect(byName.get('Tax')!.endBalance).toBeCloseTo(35000, 6)
    expect(byName.get('Roth')!.endBalance).toBeCloseTo(5000, 6)
  })

  it('flags shortfall when funds run out and stops there', () => {
    const p = projectRetirement(
      inputs({
        currentAge: 65,
        retirementAge: 60,
        planThroughAge: 90,
        postRetirementReturnPct: 0,
        postRetirementSpending: 50000,
        accounts: [newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 60000 })],
      }),
      { startYear: START },
    )
    // 60k covers year 65 fully, 10k of year 66 → shortfall at 66.
    expect(p.shortfallAge).toBe(66)
    expect(p.fundedThroughAge).toBe(65)
    expect(p.years[p.years.length - 1].shortfall).toBe(true)
    expect(p.years[p.years.length - 1].netToSpending).toBeCloseTo(10000, 6)
  })

  it('lands one-time additions in the right account and year', () => {
    const tax = newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 0 })
    const p = projectRetirement(
      inputs({
        currentAge: 40,
        planThroughAge: 42,
        preRetirementReturnPct: 0,
        preRetirementIncome: 0,
        preRetirementSpending: 0,
        accounts: [tax],
        oneTimes: [{ id: 'o1', amount: 5000, year: START + 1, accountId: tax.id }],
      }),
      { startYear: START },
    )
    expect(p.years[0].accounts[0].oneTime).toBe(0)
    expect(p.years[1].accounts[0].oneTime).toBe(5000)
    expect(p.years[1].accounts[0].endBalance).toBeCloseTo(5000, 6)
  })

  it('expresses totals in today’s dollars', () => {
    const p = projectRetirement(
      inputs({
        currentAge: 40,
        planThroughAge: 41,
        preRetirementReturnPct: 0,
        inflationPct: 10,
        preRetirementIncome: 0,
        preRetirementSpending: 0,
        accounts: [newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 100 })],
      }),
      { startYear: START },
    )
    // t=1 → infl 1.1 → $100 nominal = $90.91 today.
    expect(p.years[1].totalEnd).toBeCloseTo(100, 6)
    expect(p.years[1].totalEndToday).toBeCloseTo(100 / 1.1, 6)
  })
})

describe('availableToSavePerYear', () => {
  it('is income minus pre-retirement spending', () => {
    expect(
      availableToSavePerYear({ ...defaultRetirementInputs(), preRetirementIncome: 150000, preRetirementSpending: 90000 }),
    ).toBe(60000)
  })
})

describe('extraMonthlySavingsToCloseGap', () => {
  const gapInputs = (): RetirementInputs =>
    inputs({
      currentAge: 60,
      retirementAge: 61,
      planThroughAge: 65,
      preRetirementReturnPct: 0,
      postRetirementReturnPct: 0,
      preRetirementIncome: 100000,
      preRetirementSpending: 90000,
      postRetirementSpending: 50000,
      accounts: [newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 0 })],
    })

  it('returns 0 when there is no shortfall', () => {
    const ok = inputs({
      currentAge: 65,
      retirementAge: 60,
      planThroughAge: 66,
      postRetirementReturnPct: 0,
      postRetirementSpending: 10000,
      accounts: [newRetirementAccount({ name: 'Tax', taxTreatment: 'taxable', balance: 50000 })],
    })
    expect(extraMonthlySavingsToCloseGap(ok)).toBe(0)
  })

  it('finds extra monthly savings that close the gap', () => {
    const gi = gapInputs()
    expect(projectRetirement(gi, { startYear: START }).shortfallAge).not.toBeNull()
    const extra = extraMonthlySavingsToCloseGap(gi)
    expect(extra).not.toBeNull()
    expect(extra!).toBeGreaterThan(0)
    // The found amount actually closes the gap.
    expect(
      projectRetirement(gi, { startYear: START, extraMonthlySavings: extra! }).shortfallAge,
    ).toBeNull()
  })
})
