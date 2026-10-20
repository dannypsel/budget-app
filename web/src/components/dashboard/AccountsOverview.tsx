// Accounts overview — Simplifi-style account hierarchy on the dashboard:
// All Accounts net total, then Banking (Cash & Checking / Credit / Savings),
// Investments, Assets, Liabilities, each group with a signed subtotal and
// expandable account rows that link to their registers. Header controls
// mirror Simplifi's: Privacy Mode (mask balances) and a balance-options menu
// with "Show closed accounts". Liabilities render sign-flipped to net-worth
// convention in neutral text (never red), mirroring AccountsPage.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, Eye, EyeOff, MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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

type GroupKey = 'banking' | 'investments' | 'assets' | 'liabilities'

const SECTION_TITLE: Record<SectionKey, string> = {
  'banking-cash': 'Cash & Checking',
  'banking-credit': 'Credit',
  'banking-savings': 'Savings',
  investments: 'Investments',
  assets: 'Assets',
  liabilities: 'Liabilities',
}

const GROUP_OF_SECTION: Record<SectionKey, GroupKey> = {
  'banking-cash': 'banking',
  'banking-credit': 'banking',
  'banking-savings': 'banking',
  investments: 'investments',
  assets: 'assets',
  liabilities: 'liabilities',
}

const GROUP_TITLE: Record<GroupKey, string> = {
  banking: 'Banking',
  investments: 'Investments',
  assets: 'Assets',
  liabilities: 'Liabilities',
}

const GROUP_ORDER: GroupKey[] = ['banking', 'investments', 'assets', 'liabilities']
const SECTION_ORDER: SectionKey[] = [
  'banking-cash',
  'banking-credit',
  'banking-savings',
  'investments',
  'assets',
  'liabilities',
]

interface Row {
  id: string
  name: string
  type: string
  balance: number | null
  href: string
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

export default function AccountsOverview() {
  const { data: plaid = [] } = useAccountsWithBalance()
  const { data: manual = [] } = useSeparateAccounts()
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(['banking', 'banking-cash', 'banking-credit', 'banking-savings']),
  )
  const [privacyMode, setPrivacyMode] = useState(false)
  const [showClosed, setShowClosed] = useState(false)

  const bySection = useMemo(() => {
    const map = new Map<SectionKey, Row[]>()
    const push = (key: SectionKey, row: Row) => {
      const list = map.get(key)
      if (list) list.push(row)
      else map.set(key, [row])
    }
    for (const a of plaid) {
      if (!showClosed && a.is_active === false) continue
      push(plaidSection(a.type, a.subtype ?? null), {
        id: `plaid-${a.id}`,
        name: a.name,
        type: a.type,
        balance: displayedBalance(a.type, a.currentBalance ?? null),
        href: `/accounts/${a.id}`,
      })
    }
    for (const m of manual) {
      if (!showClosed && m.is_active === false) continue
      push(manualSection(m.type), {
        id: `manual-${m.id}`,
        name: m.name,
        type: m.type,
        balance: displayedBalance(m.type, m.currentBalance ?? null),
        href: `/accounts/separate/${m.id}`,
      })
    }
    return map
  }, [plaid, manual, showClosed])

  const groups = useMemo(() => {
    const sections = SECTION_ORDER.map((key) => {
      const rows = bySection.get(key) ?? []
      const total = rows.reduce((s, r) => s + (r.balance ?? 0), 0)
      return { key, title: SECTION_TITLE[key], rows, total }
    }).filter((s) => s.rows.length > 0)
    return GROUP_ORDER.map((g) => {
      const secs = sections.filter((s) => GROUP_OF_SECTION[s.key] === g)
      return {
        key: g,
        title: GROUP_TITLE[g],
        sections: secs,
        total: secs.reduce((s, sec) => s + sec.total, 0),
      }
    }).filter((g) => g.sections.length > 0)
  }, [bySection])

  const allTotal = useMemo(
    () => groups.reduce((s, g) => s + g.total, 0),
    [groups],
  )

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const money = (n: number | null) =>
    privacyMode ? '••••' : n == null ? '—' : formatCurrency(n)

  return (
    <section className="card-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-medium leading-7 text-foreground">Accounts</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPrivacyMode((v) => !v)}
            aria-pressed={privacyMode}
            title={privacyMode ? 'Privacy Mode on — balances hidden' : 'Privacy Mode'}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-container-high"
          >
            {privacyMode ? (
              <EyeOff className="h-4 w-4" aria-hidden />
            ) : (
              <Eye className="h-4 w-4" aria-hidden />
            )}
            <span className="hidden sm:inline">Privacy Mode</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Balance options"
                className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-surface-container-high"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Show / Hide</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={showClosed} onCheckedChange={setShowClosed}>
                Show Closed Accounts
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Link to="/accounts" className="text-sm font-semibold text-primary hover:underline">
            View all
          </Link>
        </div>
      </div>

      {groups.length === 0 ? (
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
              {money(allTotal)}
            </p>
          </div>
          {groups.map((group) => {
            const groupOpen = open.has(group.key)
            // Single-section groups (Investments/Assets/Liabilities) render
            // their rows directly under the group header — no redundant
            // subsection row.
            const single = group.sections.length === 1 && group.sections[0].key === group.key
            return (
              <div key={group.key} className="border-b border-border last:border-0">
                <button
                  type="button"
                  onClick={() => toggle(group.key)}
                  aria-expanded={groupOpen}
                  className="flex w-full items-center justify-between gap-3 py-2.5 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    {groupOpen ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    )}
                    <span className="text-sm font-semibold text-foreground">{group.title}</span>
                  </span>
                  <span className="text-sm font-medium tabular-nums text-muted-foreground">
                    {money(group.total)}
                  </span>
                </button>
                {groupOpen &&
                  (single ? (
                    <ul className="pb-2">
                      {group.sections[0].rows.map((r) => (
                        <AccountRow key={r.id} row={r} money={money} />
                      ))}
                    </ul>
                  ) : (
                    group.sections.map((sec) => {
                      const secOpen = open.has(sec.key)
                      return (
                        <div key={sec.key} className="pl-4">
                          <button
                            type="button"
                            onClick={() => toggle(sec.key)}
                            aria-expanded={secOpen}
                            className="flex w-full items-center justify-between gap-3 py-2 text-left"
                          >
                            <span className="flex items-center gap-1.5">
                              {secOpen ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                              )}
                              <span className="text-sm font-medium text-foreground">{sec.title}</span>
                            </span>
                            <span className="text-sm tabular-nums text-muted-foreground">
                              {money(sec.total)}
                            </span>
                          </button>
                          {secOpen && (
                            <ul className="pb-2">
                              {sec.rows.map((r) => (
                                <AccountRow key={r.id} row={r} money={money} />
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })
                  ))}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function AccountRow({
  row,
  money,
}: {
  row: Row
  money: (n: number | null) => string
}) {
  return (
    <li>
      <Link
        to={row.href}
        className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-accent"
      >
        <span className="truncate pl-6 text-sm text-muted-foreground">{row.name}</span>
        <span className={cn('shrink-0 text-sm tabular-nums text-foreground')}>
          {money(row.balance)}
        </span>
      </Link>
    </li>
  )
}
