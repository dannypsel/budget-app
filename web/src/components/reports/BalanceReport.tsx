// Net Worth / Savings reports (Simplifi parity): headline balance + area chart
// over the range, then a "<…> by month" table grouped Assets ▸ section ▸ account.
// Data: account_balance_history month-end values (lib/balanceReport).

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { TrendAreaChart } from '@/components/finance/TrendAreaChart'
import { useAccounts, useBalanceHistory } from '@/data/hooks'
import { buildBalanceReport, monthEndBalances, monthsBetween } from '@/lib/balanceReport'
import { formatCurrency } from '@/lib/money'
import { toISODate } from '@/lib/dates'
import { downloadCsv, rowsToCsv } from '@/lib/exportCsv'
import { cn } from '@/lib/utils'

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })

/** Look back this far before the range so month-end values can carry forward. */
const CARRY_DAYS = 120

export function BalanceReport({
  mode,
  start,
  end,
  exportRef,
}: {
  mode: 'net-worth' | 'savings'
  start: string
  end: string
  /** The report header's download button calls this. */
  exportRef?: { current: (() => void) | null }
}) {
  const fetchStart = useMemo(() => {
    const d = new Date(`${start}T00:00:00`)
    d.setDate(d.getDate() - CARRY_DAYS)
    return toISODate(d)
  }, [start])
  const { data: points = [], isLoading } = useBalanceHistory(fetchStart, end)
  const { data: accounts = [] } = useAccounts()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const months = useMemo(() => monthsBetween(start, end), [start, end])
  const report = useMemo(
    () => buildBalanceReport(accounts, monthEndBalances(points, months), months, mode),
    [accounts, points, months, mode],
  )
  const firstWithData = report.series.findIndex((v) => v != null)
  const chartData =
    firstWithData < 0
      ? []
      : months.slice(firstWithData).map((m, i) => ({ label: m.label.slice(0, 3), value: report.series[firstWithData + i] ?? 0 }))
  const latest = report.series[report.series.length - 1] ?? 0
  const title = mode === 'net-worth' ? 'Net worth' : 'Balance in savings'

  // Rows arrive in tree order: group, section, accounts, section total, …, group total.
  const visible = useMemo(() => {
    const out: typeof report.rows = []
    let groupCollapsed = false
    let sectionCollapsed = false
    for (const r of report.rows) {
      if (r.kind === 'group') {
        groupCollapsed = collapsed.has(r.id)
        sectionCollapsed = false
        out.push(r)
      } else if (r.kind === 'section') {
        sectionCollapsed = collapsed.has(r.id)
        if (!groupCollapsed) out.push(r)
      } else if (r.kind === 'account' || (r.kind === 'total' && r.depth === 2)) {
        if (!groupCollapsed && !sectionCollapsed) out.push(r)
      } else if (r.depth === 1) {
        if (!groupCollapsed) out.push(r)
      } else out.push(r)
    }
    return out
  }, [report, collapsed])

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  function exportCsv() {
    const csv = rowsToCsv(
      ['Account', ...months.map((m) => m.label)],
      report.rows.filter((r) => r.values.length > 0).map((r) => [r.label, ...r.values.map((v) => (v == null ? '' : v.toFixed(2)))]),
    )
    downloadCsv(`${mode}-${start}-${end}.csv`, csv)
  }
  useEffect(() => {
    if (exportRef) exportRef.current = exportCsv
  })



  if (isLoading) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading balances…</p>
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="card-surface p-4 md:p-6">
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold tabular-nums text-foreground">{formatCurrency(latest)}</p>
        <p className="mb-4 text-sm text-muted-foreground">
          {fmtDate(start)} - {fmtDate(end)}
        </p>
        {report.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No balance history in this range yet — balances are recorded on each sync.
          </p>
        ) : (
          <TrendAreaChart
            data={chartData}
            xKey="label"
            yKey="value"
            gradientId={`balance-${mode}`}
            height={280}
            showAxes
            valueFormatter={(n) => formatCurrency(n)}
            tooltipLabel={title}
          />
        )}
      </section>

      {report.rows.length > 0 && (
        <section className="card-surface p-4 md:p-6">
          <h2 className="mb-3 text-base font-semibold text-foreground">
            {mode === 'net-worth' ? 'Net worth by month' : 'Savings by month'}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs font-semibold text-muted-foreground">
                  <th className="py-2 pr-3 text-left">Account</th>
                  {months.map((m) => (
                    <th key={m.key} className="py-2 pl-3 text-right">
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const isHeader = r.kind === 'group' || r.kind === 'section'
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        r.kind === 'group' && 'bg-surface-container-low',
                        r.kind === 'total' && 'border-b border-border font-semibold',
                      )}
                    >
                      <td className="py-2 pr-3" style={{ paddingLeft: `${r.depth * 16}px` }}>
                        {isHeader ? (
                          <button
                            type="button"
                            onClick={() => toggle(r.id)}
                            aria-expanded={!collapsed.has(r.id)}
                            className="flex items-center gap-1 font-medium text-foreground"
                          >
                            {collapsed.has(r.id) ? (
                              <ChevronRight className="h-4 w-4" aria-hidden />
                            ) : (
                              <ChevronDown className="h-4 w-4" aria-hidden />
                            )}
                            {r.label}
                          </button>
                        ) : (
                          <span className={r.kind === 'account' ? 'text-foreground' : ''}>{r.label}</span>
                        )}
                      </td>
                      {months.map((m, i) => (
                        <td key={m.key} className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                          {isHeader ? '' : r.values[i] == null ? '—' : formatCurrency(r.values[i]!)}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
