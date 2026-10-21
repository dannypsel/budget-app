import { describe, expect, it } from 'vitest'
import { getBalanceMode, setBalanceMode, withPending } from './balancePref'

describe('withPending (Simplifi INCLUDE_PENDING)', () => {
  it('pending charges raise what a card owes and lower a bank balance', () => {
    // Amex daniel abp 2: 13,501.87 owed + 4,119.00 pending = Simplifi's 17,620.87
    expect(withPending('credit', 13501.87, 4119)).toBeCloseTo(17620.87, 2)
    expect(withPending('depository', 1000, 25)).toBe(975)
  })

  it('pending deposits (negative amounts) raise a bank balance', () => {
    // 360 Checking: 25,782.63 + 15,130.95 pending deposit = Simplifi's 40,913.58
    expect(withPending('depository', 25782.63, -15130.95)).toBeCloseTo(40913.58, 2)
  })

  it('defaults to including pending and remembers the bank-reported choice', () => {
    localStorage.removeItem('pocketlens.balanceMode')
    expect(getBalanceMode()).toBe('include-pending')
    setBalanceMode('bank')
    expect(getBalanceMode()).toBe('bank')
    setBalanceMode('include-pending')
  })
})
