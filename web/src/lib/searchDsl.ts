// Register search syntax — a port of Simplifi's QDataGrid DSL (parseDSL +
// REGISTER_KEYWORD_MAPPINGS, common chunk module 330420; documented in its
// "Shortcuts" drawer, REGISTER_SEARCH_SECTIONS). Space-separated terms AND
// together; quoted phrases stay one term; anything that isn't a constraint is
// free text matched against payee / statement name / notes / category.
//
//   payee:walmart  payee:walmart,target  "Walmart Store"
//   date=this-month  date=-30d  date>=2024-01-01  date:2024-01-01..2024-03-31
//   amount>100  amount=50ish  amount:50..200  expense>500  income>1000
//   category="Dining & Drinks"  category!="Dining & Drinks"  is:uncategorized
//   is:pending  is:cleared  is:reviewed  not:reviewed  is:flagged  flag:red
//   tags:reimbursable  is:tags  not:tags  is:notes  is:excluded  account:checking
//   PocketLens extras: is:transfer  is:split  is:hidden
//
// PocketLens sign convention: amount > 0 = expense, amount < 0 = income.

import { displayName, hasSplits, isTransfer, txnTags, type Account, type Category, type Transaction, type UUID } from '@/types/domain'

export type Operator = '=' | ':' | '!=' | '>' | '>=' | '<' | '<=' | '~=' | 'range'

export interface Constraint {
  field: string
  operator: Operator
  value: string
  values?: string[]
  rangeStart?: string
  rangeEnd?: string
  /** '-' = expenses only, '+' = income only (from expense:/income: or a signed value). */
  sign?: '-' | '+'
  fuzzyPercent?: number
  fuzzyDays?: number
}

export interface ParsedQuery {
  constraints: Constraint[]
  text: string[]
}

interface KeywordMapping {
  field: string
  operator: Operator
  value: string
  negatedOperator?: Operator
  negatedValue?: string
}

/** Simplifi's REGISTER_KEYWORD_MAPPINGS (business-only keys dropped) + PocketLens extras. */
export const KEYWORDS: Record<string, KeywordMapping> = {
  reviewed: { field: 'reviewed', operator: '=', value: 'true', negatedValue: 'false' },
  excluded: { field: 'exclusion', operator: '=', value: 'true', negatedValue: 'false' },
  flag: { field: 'flag', operator: '!=', value: 'NONE', negatedOperator: '=', negatedValue: 'NONE' },
  flagged: { field: 'flag', operator: '!=', value: 'NONE', negatedOperator: '=', negatedValue: 'NONE' },
  notes: { field: 'notes', operator: '!=', value: '', negatedOperator: '=', negatedValue: '' },
  tags: { field: 'tags', operator: '!=', value: '', negatedOperator: '=', negatedValue: '' },
  pending: { field: 'status', operator: '=', value: 'pending' },
  cleared: { field: 'status', operator: '=', value: 'cleared' },
  uncategorized: { field: 'category', operator: '=', value: 'uncategorized', negatedOperator: '!=', negatedValue: 'uncategorized' },
  transfer: { field: 'transfer', operator: '=', value: 'true', negatedValue: 'false' },
  split: { field: 'split', operator: '=', value: 'true', negatedValue: 'false' },
  hidden: { field: 'hidden', operator: '=', value: 'true', negatedValue: 'false' },
}

const SIGNED_FIELDS: Record<string, { field: string; sign: '-' | '+' }> = {
  expense: { field: 'amount', sign: '-' },
  expenses: { field: 'amount', sign: '-' },
  income: { field: 'amount', sign: '+' },
}

const FIELD_ALIASES: Record<string, string> = {
  tag: 'tags',
  memo: 'notes',
  note: 'notes',
  statement: 'payee',
  merchant: 'payee',
  status: 'status',
}

const KNOWN_FIELDS = new Set([
  'amount', 'date', 'payee', 'description', 'category', 'account', 'tags', 'notes',
  'status', 'flag', 'reviewed', 'exclusion', 'transfer', 'split', 'hidden',
])

const FIELD_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)(~=?|!=|[><=]{1,2}|:)(.+)$/
const BARE_RE = /^(-|\+)?(~=?|[><=]{1,2})(.+)$/
const KEYWORD_RE = /^(is|not):([a-zA-Z,]+)$/i
const RANGE_RE = /^(.+?)\.\.(.+)$/
const ISH_RE = /^(.+?)ish(%\d+|[dD]\d+)?$/i
const RELATIVE_WORDS = new Set([
  'today', 'yesterday', 'thisweek', 'lastweek', 'thismonth', 'lastmonth',
  'thisquarter', 'lastquarter', 'thisyear', 'lastyear', 'ytd', 'q1', 'q2', 'q3', 'q4',
])
const RELATIVE_OFFSET = /^([+-])(\d+)([dwmy])$/i
const PHRASE_NORMALIZE: [RegExp, string][] = [
  [/\byear[\s-]+to[\s-]+date\b/gi, 'ytd'],
  [/\blast[\s-]+week\b/gi, 'lastweek'],
  [/\blast[\s-]+month\b/gi, 'lastmonth'],
  [/\blast[\s-]+quarter\b/gi, 'lastquarter'],
  [/\blast[\s-]+year\b/gi, 'lastyear'],
  [/\bthis[\s-]+week\b/gi, 'thisweek'],
  [/\bthis[\s-]+month\b/gi, 'thismonth'],
  [/\bthis[\s-]+quarter\b/gi, 'thisquarter'],
  [/\bthis[\s-]+year\b/gi, 'thisyear'],
]

/** Split on spaces outside quotes; a quote opened mid-token stays in the token. */
function tokenize(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = ''
      cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ' ') {
      if (cur) out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function unquote(s: string): { value: string; quoted: boolean } {
  if (/^"[^"]*"$/.test(s) || /^'[^']*'$/.test(s)) return { value: s.slice(1, -1), quoted: true }
  return { value: s, quoted: false }
}

function splitList(s: string): string[] | null {
  if (!s.includes(',')) return null
  const parts: string[] = []
  let cur = ''
  let quote = ''
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ',') {
      if (cur.trim()) parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts.length > 1 ? parts : null
}

const isAmountLike = (s: string) => /^[+-]?\$?\d[\d,]*(\.\d+)?$/.test(s.trim())
export const isDateLike = (s: string) => resolveDate(s, new Date()) != null

function parseTerm(term: string): Constraint | null {
  const kw = term.match(KEYWORD_RE)
  if (kw) {
    const negate = kw[1].toLowerCase() === 'not'
    const keys = kw[2].toLowerCase().split(',').filter(Boolean)
    const maps = keys.map((k) => KEYWORDS[k])
    if (maps.some((m) => !m)) return null
    if (new Set(maps.map((m) => m.field)).size !== 1) return null
    if (negate && !maps.every((m) => m.negatedValue !== undefined)) return null
    const values = maps.map((m) => (negate ? m.negatedValue! : m.value))
    const first = maps[0]
    const operator = negate && first.negatedOperator ? first.negatedOperator : first.operator
    return { field: first.field, operator, value: values[0], ...(values.length > 1 && { values }) }
  }

  const fm = term.match(FIELD_RE)
  if (fm) {
    const [, rawField, op, rawValue] = fm
    const lower = rawField.toLowerCase()
    const signed = SIGNED_FIELDS[lower]
    const field = signed?.field ?? FIELD_ALIASES[lower] ?? lower
    if (!KNOWN_FIELDS.has(field)) return null
    const { value, quoted } = unquote(rawValue)
    const sign = signed?.sign
    const operator = (op === '~' ? '~=' : op) as Operator
    if ((operator === ':' || operator === '=') && !quoted) {
      const r = value.match(RANGE_RE)
      if (r) return { field, operator: 'range', value, rangeStart: r[1], rangeEnd: r[2], ...(sign && { sign }) }
      const ish = value.match(ISH_RE)
      if (ish && (isAmountLike(ish[1]) || isDateLike(ish[1]))) {
        return { field, operator: '~=', value: ish[1], ...(sign && { sign }), ...fuzzy(ish[2]) }
      }
    }
    if (operator === '~=') {
      const ish = value.match(/^(.+?)(%\d+|[dD]\d+)?$/)!
      return { field, operator, value: ish[1], ...(sign && { sign }), ...fuzzy(ish[2]) }
    }
    const list = quoted ? null : splitList(value)
    if (list) return { field, operator, value: list[0], values: list, ...(sign && { sign }) }
    return { field, operator, value, ...(sign && { sign }) }
  }

  const bare = term.match(BARE_RE)
  if (bare) {
    const [, s, op, value] = bare
    const field = isAmountLike(value) ? 'amount' : isDateLike(value) ? 'date' : null
    if (field) {
      const sign = s === '-' || s === '+' ? (s as '-' | '+') : undefined
      const operator = (op === '~' ? '~=' : op) as Operator
      return { field, operator, value, ...(sign && { sign }) }
    }
  }
  return null
}

function fuzzy(suffix: string | undefined): Pick<Constraint, 'fuzzyPercent' | 'fuzzyDays'> {
  if (!suffix) return {}
  if (suffix.startsWith('%')) return { fuzzyPercent: Number(suffix.slice(1)) }
  return { fuzzyDays: Number(suffix.slice(1)) }
}

export function parseQuery(input: string): ParsedQuery {
  let s = input.trim()
  if (!s) return { constraints: [], text: [] }
  for (const [re, rep] of PHRASE_NORMALIZE) s = s.replace(re, rep)
  const constraints: Constraint[] = []
  const text: string[] = []
  for (const term of tokenize(s)) {
    const c = parseTerm(term)
    if (c) constraints.push(c)
    else text.push(unquote(term).value)
  }
  return { constraints, text }
}

// ── Dates ────────────────────────────────────────────────────────────────

/** Inclusive [start, end] ISO dates for a date value, or null when unparseable. */
export function resolveDate(raw: string, now: Date): [string, string] | null {
  let v = raw.trim().toLowerCase()
  for (const [re, rep] of PHRASE_NORMALIZE) v = v.replace(re, rep)
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const y = now.getFullYear()
  const m = now.getMonth()
  const day = (yy: number, mm: number, dd: number) => new Date(yy, mm, dd)
  const today = day(y, m, now.getDate())
  const quarter = (yy: number, q: number): [string, string] => [iso(day(yy, q * 3, 1)), iso(day(yy, q * 3 + 3, 0))]
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return [v, v]
  let mt = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (mt) {
    const yy = mt[3].length === 2 ? 2000 + Number(mt[3]) : Number(mt[3])
    const d = iso(day(yy, Number(mt[1]) - 1, Number(mt[2])))
    return [d, d]
  }
  mt = v.match(/^(\d{4})-(\d{2})$/)
  if (mt) return [iso(day(Number(mt[1]), Number(mt[2]) - 1, 1)), iso(day(Number(mt[1]), Number(mt[2]), 0))]
  mt = v.match(/^(\d{4})-?q([1-4])$/)
  if (mt) return quarter(Number(mt[1]), Number(mt[2]) - 1)
  mt = v.match(RELATIVE_OFFSET)
  if (mt) {
    const n = Number(mt[2]) * (mt[1] === '-' ? -1 : 1)
    const unit = mt[3].toLowerCase()
    const other = new Date(today)
    if (unit === 'd') other.setDate(other.getDate() + n)
    else if (unit === 'w') other.setDate(other.getDate() + n * 7)
    else if (unit === 'm') other.setMonth(other.getMonth() + n)
    else other.setFullYear(other.getFullYear() + n)
    return n < 0 ? [iso(other), iso(today)] : [iso(today), iso(other)]
  }
  if (!RELATIVE_WORDS.has(v)) return null
  const dow = today.getDay()
  switch (v) {
    case 'today':
      return [iso(today), iso(today)]
    case 'yesterday': {
      const d = iso(day(y, m, now.getDate() - 1))
      return [d, d]
    }
    case 'thisweek':
      return [iso(day(y, m, now.getDate() - dow)), iso(day(y, m, now.getDate() - dow + 6))]
    case 'lastweek':
      return [iso(day(y, m, now.getDate() - dow - 7)), iso(day(y, m, now.getDate() - dow - 1))]
    case 'thismonth':
      return [iso(day(y, m, 1)), iso(day(y, m + 1, 0))]
    case 'lastmonth':
      return [iso(day(y, m - 1, 1)), iso(day(y, m, 0))]
    case 'thisquarter':
      return quarter(y, Math.floor(m / 3))
    case 'lastquarter': {
      const q = Math.floor(m / 3) - 1
      return q < 0 ? quarter(y - 1, 3) : quarter(y, q)
    }
    case 'thisyear':
      return [`${y}-01-01`, `${y}-12-31`]
    case 'lastyear':
      return [`${y - 1}-01-01`, `${y - 1}-12-31`]
    case 'ytd':
      return [`${y}-01-01`, iso(today)]
    default:
      return quarter(y, Number(v.slice(1)) - 1)
  }
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)) + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The date window a query restricts to (for choosing what to fetch), or null. */
export function dateWindow(q: ParsedQuery, now = new Date()): [string, string] | null {
  let lo = '0000-01-01'
  let hi = '9999-12-31'
  let any = false
  for (const c of q.constraints) {
    if (c.field !== 'date' || c.values) continue
    if (c.operator === 'range') {
      const a = resolveDate(c.rangeStart!, now)
      const b = resolveDate(c.rangeEnd!, now)
      if (!a || !b) continue
      lo = a[0] > lo ? a[0] : lo
      hi = b[1] < hi ? b[1] : hi
      any = true
      continue
    }
    const r = resolveDate(c.value, now)
    if (!r) continue
    const pad = c.operator === '~=' ? (c.fuzzyDays ?? 3) : 0
    const [s, e] = [addDays(r[0], -pad), addDays(r[1], pad)]
    if (c.operator === '=' || c.operator === ':' || c.operator === '~=') {
      lo = s > lo ? s : lo
      hi = e < hi ? e : hi
    } else if (c.operator === '>' || c.operator === '>=') {
      const b = c.operator === '>' ? addDays(e, 1) : s
      lo = b > lo ? b : lo
    } else if (c.operator === '<' || c.operator === '<=') {
      const b = c.operator === '<' ? addDays(s, -1) : e
      hi = b < hi ? b : hi
    } else continue
    any = true
  }
  return any ? [lo, hi] : null
}

// ── Matching ─────────────────────────────────────────────────────────────

export interface MatchContext {
  accountsById?: Map<UUID, Account>
  categoriesById?: Map<UUID, Category>
  now?: Date
}

function categoryPath(t: Transaction, ctx: MatchContext): string[] {
  const names: string[] = []
  let c: Category | null | undefined = t.categories
  const seen = new Set<string>()
  while (c && !seen.has(c.id)) {
    seen.add(c.id)
    names.push(c.name.toLowerCase())
    c = c.parent_id ? ctx.categoriesById?.get(c.parent_id) : null
  }
  for (const s of t.transaction_splits ?? []) if (s.categories) names.push(s.categories.name.toLowerCase())
  return names
}

function num(s: string): number {
  return Number(s.replace(/[$,\s]/g, ''))
}

function compareNumber(actual: number, c: Constraint, target: string): boolean {
  const v = Math.abs(num(target))
  if (Number.isNaN(v)) return false
  switch (c.operator) {
    case '=':
    case ':':
      return Math.abs(actual - v) < 0.005
    case '!=':
      return Math.abs(actual - v) >= 0.005
    case '>':
      return actual > v
    case '>=':
      return actual >= v - 0.005
    case '<':
      return actual < v
    case '<=':
      return actual <= v + 0.005
    case '~=': {
      const pct = (c.fuzzyPercent ?? 10) / 100
      return actual >= v * (1 - pct) - 0.005 && actual <= v * (1 + pct) + 0.005
    }
    default:
      return false
  }
}

function matchAmount(t: Transaction, c: Constraint): boolean {
  const sign = c.sign ?? (/^[+-]/.test(c.value.trim()) ? (c.value.trim()[0] as '-' | '+') : undefined)
  if (sign === '-' && t.amount <= 0) return false
  if (sign === '+' && t.amount >= 0) return false
  const actual = Math.abs(t.amount)
  if (c.operator === 'range') {
    const a = Math.abs(num(c.rangeStart!))
    const b = Math.abs(num(c.rangeEnd!))
    return actual >= Math.min(a, b) - 0.005 && actual <= Math.max(a, b) + 0.005
  }
  const targets = c.values ?? [c.value]
  return c.operator === '!='
    ? targets.every((v) => compareNumber(actual, c, v))
    : targets.some((v) => compareNumber(actual, c, v))
}

function matchDate(t: Transaction, c: Constraint, now: Date): boolean {
  const d = t.effective_date
  if (c.operator === 'range') {
    const a = resolveDate(c.rangeStart!, now)
    const b = resolveDate(c.rangeEnd!, now)
    return !!a && !!b && d >= a[0] && d <= b[1]
  }
  const one = (raw: string) => {
    const r = resolveDate(raw, now)
    if (!r) return false
    const pad = c.operator === '~=' ? (c.fuzzyDays ?? 3) : 0
    const [s, e] = [addDays(r[0], -pad), addDays(r[1], pad)]
    switch (c.operator) {
      case '=':
      case ':':
      case '~=':
        return d >= s && d <= e
      case '!=':
        return d < s || d > e
      case '>':
        return d > e
      case '>=':
        return d >= s
      case '<':
        return d < s
      case '<=':
        return d <= e
      default:
        return false
    }
  }
  const targets = c.values ?? [c.value]
  return c.operator === '!=' ? targets.every(one) : targets.some(one)
}

function matchText(haystack: string[], c: Constraint, exact: boolean): boolean {
  const targets = (c.values ?? [c.value]).map((v) => v.toLowerCase())
  const hit = (v: string) =>
    v === '' ? haystack.length === 0 : haystack.some((h) => (exact && c.operator !== ':' ? h === v : h.includes(v)))
  if (c.operator === '!=') return !targets.some(hit)
  return targets.some(hit)
}

function matchBool(actual: boolean, c: Constraint): boolean {
  const want = (c.values ?? [c.value]).some((v) => v === 'true')
  return c.operator === '!=' ? actual !== want : actual === want
}

function matchConstraint(t: Transaction, c: Constraint, ctx: MatchContext): boolean {
  const now = ctx.now ?? new Date()
  switch (c.field) {
    case 'amount':
      return matchAmount(t, c)
    case 'date':
      return matchDate(t, c, now)
    case 'payee':
    case 'description':
      return matchText(
        [displayName(t), t.description, t.original_description].filter((x): x is string => !!x).map((x) => x.toLowerCase()),
        c,
        false,
      )
    case 'category': {
      const names = categoryPath(t, ctx)
      if ((c.values ?? [c.value]).some((v) => v.toLowerCase() === 'uncategorized') && names.length === 0) {
        return c.operator !== '!='
      }
      return matchText(names, c, true)
    }
    case 'account': {
      const a = ctx.accountsById?.get(t.account_id)
      return matchText([a?.name, a?.official_name, a?.mask].filter((x): x is string => !!x).map((x) => x.toLowerCase()), c, false)
    }
    case 'tags': {
      const names = txnTags(t).map((x) => x.name.toLowerCase())
      if (t.need_want) names.push(t.need_want)
      if (t.spend_pattern) names.push(t.spend_pattern)
      if (c.value === '' && !c.values) return c.operator === '!=' ? names.length > 0 : names.length === 0
      return matchText(names, c, true)
    }
    case 'notes': {
      const notes = (t.notes ?? '').toLowerCase()
      if (c.value === '' && !c.values) return c.operator === '!=' ? notes !== '' : notes === ''
      return matchText(notes ? [notes] : [], c, false)
    }
    case 'status': {
      const status = t.pending ? 'pending' : 'cleared'
      const targets = (c.values ?? [c.value]).map((v) => v.toLowerCase())
      return c.operator === '!=' ? !targets.includes(status) : targets.includes(status)
    }
    case 'flag': {
      const flag = t.user_flag ?? 'NONE'
      const targets = (c.values ?? [c.value]).map((v) => v.toUpperCase())
      return c.operator === '!=' ? !targets.includes(flag) : targets.includes(flag)
    }
    case 'reviewed':
      return matchBool(!!t.reviewed, c)
    case 'exclusion':
      return matchBool(t.exclude_from_totals || t.hidden, c)
    case 'transfer':
      return matchBool(isTransfer(t), c)
    case 'split':
      return matchBool(hasSplits(t), c)
    case 'hidden':
      return matchBool(t.hidden, c)
    default:
      return true
  }
}

function matchFreeText(t: Transaction, term: string): boolean {
  const q = term.toLowerCase()
  if (isAmountLike(term) && Math.abs(Math.abs(t.amount) - Math.abs(num(term))) < 0.005) return true
  return [displayName(t), t.description, t.original_description, t.notes, t.categories?.name]
    .some((f) => f?.toLowerCase().includes(q))
}

export function matchesQuery(t: Transaction, q: ParsedQuery, ctx: MatchContext = {}): boolean {
  return q.constraints.every((c) => matchConstraint(t, c, ctx)) && q.text.every((term) => matchFreeText(t, term))
}

/** The Shortcuts help drawer content (Simplifi's REGISTER_SEARCH_SECTIONS). */
export const SEARCH_SECTIONS: { title: string; description: string; examples: [string, string][] }[] = [
  {
    title: 'Payee or description',
    description: 'Filter by payee name or any word in the transaction.',
    examples: [
      ['groceries', 'Any field contains this word'],
      ['"Walmart Store"', 'Exact phrase'],
      ['payee:walmart', 'Payee contains'],
      ['payee:walmart,target', 'Match any of these payees (OR)'],
    ],
  },
  {
    title: 'Date',
    description: 'Filter to a specific date or time period.',
    examples: [
      ['date=this-month', 'This calendar month'],
      ['date=-30d', 'Last 30 days'],
      ['date>=2024-01-01', 'On or after a date'],
      ['date:2024-01-01..2024-03-31', 'Between two dates'],
    ],
  },
  {
    title: 'Amount',
    description: 'Filter by exact amount, comparison, or range.',
    examples: [
      ['amount>100', 'More than $100'],
      ['amount=50ish', 'Around $50 (±10%)'],
      ['amount:50..200', 'Between $50 and $200'],
      ['expense>500', 'Expenses over $500'],
    ],
  },
  {
    title: 'Category',
    description: 'Filter by category or find uncategorized transactions.',
    examples: [
      ['category="Dining & Drinks"', 'Match a specific category'],
      ['category!="Dining & Drinks"', 'Exclude a category'],
      ['is:uncategorized', 'No category assigned'],
    ],
  },
  {
    title: 'Status & review',
    description: 'Filter by transaction status or review state.',
    examples: [
      ['is:pending', 'Pending transactions'],
      ['not:reviewed', 'Not yet reviewed'],
      ['is:reviewed', 'Reviewed'],
      ['is:flagged', 'Has a color flag'],
    ],
  },
  {
    title: 'Tags',
    description: 'Filter by assigned tags.',
    examples: [
      ['tags:reimbursable', 'Has a specific tag'],
      ['is:tags', 'Has any tag'],
      ['not:tags', 'Has no tags'],
    ],
  },
  {
    title: 'Account',
    description: 'Filter by account name or last four digits.',
    examples: [
      ['account:checking', 'Account name contains'],
      ['is:transfer', 'Transfers between your accounts'],
    ],
  },
]
