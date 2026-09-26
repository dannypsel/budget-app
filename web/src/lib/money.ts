// Money conventions mirror the iOS app:
//   transactions.amount  -> POSITIVE = money out (spend/debit), NEGATIVE = money in (income)
//   net worth / balances -> plain signed numbers
// The UI shows magnitude only; income is green, expense is red (Keep's money tokens).

// 'narrowSymbol' renders a bare "$" for USD and CAD alike in every locale. Without it,
// Intl disambiguates by locale — an en-CA browser shows USD as "US$", an en-US browser
// shows CAD as "CA$" — which is not what a single-currency household wants to read.
const CURRENCY_DISPLAY = 'narrowSymbol' as const

const currencyFmt = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: CURRENCY_DISPLAY,
})

// App-wide default currency (ISO code) — set once from the user's profile
// after auth is ready (see PocketLensApp). The per-call `currency` argument
// always wins; this is only the fallback for call sites that don't pass one.
let defaultCurrency = 'USD'

/** Override the fallback currency for formatCurrency/formatAmount. */
export function setDefaultCurrency(code: string): void {
  if (code && code.trim().length > 0) defaultCurrency = code.trim().toUpperCase()
}

/** The current fallback currency ('USD' until setDefaultCurrency is called). */
export function getDefaultCurrency(): string {
  return defaultCurrency
}

/** "$1,234.56" — signed. Tolerant of arbitrary/unknown ISO codes — investment holdings
 *  can carry any currency Plaid returns; falls back to "12.34 XYZ" if Intl rejects the code. */
export function formatCurrency(n: number, currency: string = getDefaultCurrency()): string {
  if (currency === 'USD') return currencyFmt.format(n)
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: CURRENCY_DISPLAY,
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

/** Magnitude only, e.g. "$65.00" (used for transaction rows like iOS AmountText). */
export function formatAmount(n: number, currency: string = getDefaultCurrency()): string {
  return formatCurrency(Math.abs(n), currency)
}

/** True when a transaction amount represents spend (money out). */
export function isDebit(amount: number): boolean {
  return amount > 0
}

/** Tailwind text color class for a transaction amount (Keep money tokens). */
export function amountColorClass(amount: number): string {
  return amount > 0 ? 'text-money-expense' : 'text-money-income'
}
