// Accounts overview — Simplifi-style account hierarchy on the dashboard:
// All Accounts net total, then Banking (Cash & Checking / Credit / Savings),
// Investments, Assets, Liabilities. Each non-empty section expands to its
// account rows. Liabilities render sign-flipped to net-worth convention in
// neutral text (never red), mirroring AccountsPage.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useAccountsWithBalance, useSeparateAccounts } from '@/data/hooks'
import { isLiabilityType } from '@/types/domain'
import { formatCurrency } from '@/lib/money'
import { cn } from '@/lib/utils'

type SectionKey =
  | 'banking-cash'
  | 'banking-credit'
  | 'banking-savings'
  | 'investments'
  | 'assets'
  | 'liabilities'

const SECTION_TITLE: Record<SectionKey, string> = {
  'banking-cash': 'Cash & Checking',
  'banking-credit': 'Credit',
  'banking-savings': 'Savings',
  investments: 'Investments',
  assets: 'Assets',
  liabilities: 'Liabilities',
}

interface Row {
  id: string
  name: string
  type: string
  balance: number | null
}

/** Displayed balance: liabilities flip to net-worth convention; null → null. */
function displayedBalance(type: string, balance: number | null): number | null {
  if (balance == null) return null
  return isLiabilityType(type) ? -balance : balance
}

function plaidSection(type: string, subtype: string | null): SectionKey {
  if (type === 'credit') return 'banking-credit'
  if (type === 'depository') return subtype === 'savings' ? 'banking-savings' : 'banking-cash'
  if (type === 'investment') return 'investments'
  if (type === 'loan') return 'liabilities'
  return 'assets'
}

function manualSection(type: string): SectionKey {
  if (type === 'credit') return 'banking-credit'
  if (type === 'savings') return 'banking-savings'
  if (type === 'checking' || type === 'depository') return 'banking-cash'
  if (type === 'investment') return 'investments'
  if (type === 'loan') return 'liabilities'
  return 'assets'
}

// Section render order; Banking's three subsections stay together.
const SECTION_ORDER: SectionKey[] = [
  'banking-cash',
  'banking-credit',
  'banking-savings',
  'investments',
  'assets',
  'liabilities',
]

export default function AccountsOverview() {
  const { data: plaid = [] } = useAccountsWithBalance()
  const { data: manual = [] } = useSeparateAccounts()
  const [open, setOpen] = useState<Set<SectionKey>>(
    () => new Set(['banking-cash', 'banking-credit', 'banking-savings']),
  )

  const bySection = useMemo(() => {
    const map = new Map<SectionKey, Row[]>()
    const push = (key: SectionKey, row: Row) => {
      const list = map.get(key)
      if (list) list.push(row)
      else map.set(key, [row])
    }
    for (const a of plaid) {
      if (a.is_active === false) continue
      push(plaidSection(a.type, a.subtype ?? null), {
        id: `plaid-${a.id}`,
        name: a.name,
        type: a.type,
        balance: displayedBalance(a.type, a.currentBalance ?? null),
      })
    }
    for (const m of manual) {
      if (m.is_active === false) continue
      push(manualSection(m.type), {
        id: `manual-${m.id}`,
        name: m.name,
        type: m.type,
        balance: displayedBalance(m.type, m.currentBalance ?? null),
      })
    }
    return map
  }, [plaid, manual])

  const sections = useMemo(
    () =>
      SECTION_ORDER.map((key) => {
        const rows = bySection.get(key) ?? []
        const total = rows.reduce(
          (s, r) => s + (r.balance ?? 0),
          0,
        )
        return { key, title: SECTION_TITLE[key], rows, total }
      }).filter((s) => s.rows.length > 0),
    [bySection],
  )

  const allTotal = useMemo(
    () => sections.reduce((s, sec) => s + sec.total, 0),
    [sections],
  )

  function toggle(key: SectionKey) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className="card-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-medium leading-7 text-foreground">Accounts</h2>
        <Link to="/accounts" className="text-sm font-semibold text-primary hover:underline">
          View all
        </Link>
      </div>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No accounts yet.{' '}
          <Link to="/accounts" className="font-semibold text-primary hover:underline">
            Add an account
          </Link>{' '}
          to see balances here.
        </p>
      ) : (
        <div>
          <div className="flex items-center justify-between border-b border-border py-2.5">
            <p className="text-sm font-semibold text-foreground">All Accounts</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {formatCurrency(allTotal)}
            </p>
          </div>
          {sections.map((sec) => {
            const expanded = open.has(sec.key)
            return (
              <div key={sec.key} className="border-b border-border last:border-0">
                <button
                  type="button"
                  onClick={() => toggle(sec.key)}
                  aria-expanded={expanded}
                  className="flex w-full items-center justify-between gap-3 py-2.5 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    )}
                    <span className="text-sm font-medium text-foreground">{sec.title}</span>
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {formatCurrency(sec.total)}
                  </span>
                </button>
                {expanded && (
                  <ul className="pb-2">
                    {sec.rows.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between gap-3 py-1.5 pl-7"
                      >
                        <span className="truncate text-sm text-muted-foreground">{r.name}</span>
                        <span
                          className={cn(
                            'shrink-0 text-sm tabular-nums text-foreground',
                          )}
                        >
                          {r.balance == null ? '—' : formatCurrency(r.balance)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
