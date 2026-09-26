import { describe, expect, it } from 'vitest'
import { guessColumn, parseAmountLoose, parseDateLoose } from './CsvImportDialog'

describe('parseDateLoose', () => {
  it('passes through ISO dates', () => {
    expect(parseDateLoose('2026-09-25')).toBe('2026-09-25')
  })
  it('parses US slash dates', () => {
    expect(parseDateLoose('9/5/2026')).toBe('2026-09-05')
    expect(parseDateLoose('12/31/2026')).toBe('2026-12-31')
  })
  it('parses dash dates and 2-digit years', () => {
    expect(parseDateLoose('9-5-26')).toBe('2026-09-05')
  })
  it('returns null for garbage', () => {
    expect(parseDateLoose('not a date')).toBeNull()
    expect(parseDateLoose('')).toBeNull()
  })
})

describe('parseAmountLoose', () => {
  it('parses plain and formatted amounts', () => {
    expect(parseAmountLoose('42.50')).toBe(42.5)
    expect(parseAmountLoose('$1,234.56')).toBe(1234.56)
    expect(parseAmountLoose('-12.00')).toBe(-12)
  })
  it('treats parentheses as negative (accounting style)', () => {
    expect(parseAmountLoose('(12.00)')).toBe(-12)
  })
  it('returns null for non-numbers', () => {
    expect(parseAmountLoose('abc')).toBeNull()
    expect(parseAmountLoose('')).toBeNull()
  })
})

describe('guessColumn', () => {
  const headers = ['Posted Date', 'Description', 'Amount', 'Balance']
  it('matches case-insensitively on substrings', () => {
    expect(guessColumn(headers, ['date'])).toBe('Posted Date')
    expect(guessColumn(headers, ['merchant', 'description'])).toBe('Description')
    expect(guessColumn(headers, ['amount'])).toBe('Amount')
  })
  it('returns empty string when nothing matches', () => {
    expect(guessColumn(headers, ['zzz'])).toBe('')
  })
})
