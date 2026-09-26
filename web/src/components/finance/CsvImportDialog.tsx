// CSV transaction importer dialog.
//
// The parse + insert machinery already existed (lib/csv.ts parseCsv and
// data/transactions.ts importTransactions); the old /import page was disabled
// upstream, so this dialog is the UI that was missing. Flow:
//   1. pick a Plaid-synced account (separate/manual accounts live in a
//      different table and can't receive imported rows)
//   2. choose a CSV file -> parsed in-browser, never uploaded anywhere
//   3. map Date / Amount / Merchant columns (auto-guessed from header names)
//   4. preview, then import; duplicates are skipped idempotently by
//      importTransactions (synthetic plaid_transaction_id + upsert).

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { parseCsv, type ParsedCsv } from '@/lib/csv'
import { importTransactions, type ImportRow } from '@/data/transactions'
import { detectCreditsAfterImport } from '@/data/churning'
import { autoCategorize } from '@/data/aiCategorize'
import type { Account, UUID } from '@/types/domain'

export type CsvImportDialogProps = {
  open: boolean
  accounts: Account[]
  onOpenChange: (open: boolean) => void
}

export function guessColumn(headers: string[], candidates: string[]): string {
  const lowered = headers.map((h) => h.toLowerCase())
  for (const c of candidates) {
    const i = lowered.findIndex((h) => h.includes(c))
    if (i >= 0) return headers[i]
  }
  return ''
}

/** Parse a loose date into yyyy-MM-dd. Returns null when unparseable. */
export function parseDateLoose(raw: string): string | null {
  const s = raw.trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  return null
}

export function parseAmountLoose(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '').replace(/[()]/g, (c) => (c === '(' ? '-' : ''))
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export default function CsvImportDialog({ open, accounts, onOpenChange }: CsvImportDialogProps) {
  const qc = useQueryClient()
  const [accountId, setAccountId] = useState<string>('')
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [fileName, setFileName] = useState('')
  const [dateCol, setDateCol] = useState('')
  const [amountCol, setAmountCol] = useState('')
  const [merchantCol, setMerchantCol] = useState('')
  const [spendNegative, setSpendNegative] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeAccounts = useMemo(() => accounts.filter((a) => a.is_active), [accounts])

  const mappedRows = useMemo<(ImportRow & { skipped: boolean })[]>(() => {
    if (!parsed || !dateCol || !amountCol || !merchantCol) return []
    const di = parsed.headers.indexOf(dateCol)
    const ai = parsed.headers.indexOf(amountCol)
    const mi = parsed.headers.indexOf(merchantCol)
    if (di < 0 || ai < 0 || mi < 0) return []
    return parsed.rows.map((r) => {
      const date = parseDateLoose(r[di] ?? '')
      let amount = parseAmountLoose(r[ai] ?? '')
      // DB convention: positive = spend. Bank exports usually show spending as
      // negative, so flip by default (matches our own CSV export format).
      if (amount != null && spendNegative) amount = -amount
      const merchant = (r[mi] ?? '').trim()
      const skipped = date == null || amount == null || merchant === ''
      return { date: date ?? '', amount: amount ?? 0, merchant, skipped }
    })
  }, [parsed, dateCol, amountCol, merchantCol, spendNegative])

  const validCount = mappedRows.filter((r) => !r.skipped).length
  const skippedCount = mappedRows.filter((r) => r.skipped).length

  function reset() {
    setParsed(null)
    setFileName('')
    setDateCol('')
    setAmountCol('')
    setMerchantCol('')
    setError(null)
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    try {
      const text = await file.text()
      const p = parseCsv(text)
      if (p.headers.length === 0 || p.rows.length === 0) {
        setError('That file has no data rows.')
        return
      }
      setParsed(p)
      setFileName(file.name)
      setDateCol((v) => v || guessColumn(p.headers, ['date', 'posted', 'transaction date']))
      setAmountCol((v) => v || guessColumn(p.headers, ['amount']))
      setMerchantCol(
        (v) => v || guessColumn(p.headers, ['merchant', 'description', 'name', 'payee', 'memo']),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.')
    }
  }

  async function onImport() {
    if (!accountId) {
      setError('Pick an account first.')
      return
    }
    const rows = mappedRows.filter((r) => !r.skipped)
    if (rows.length === 0) {
      setError('No valid rows to import — check the column mapping.')
      return
    }
    setImporting(true)
    setError(null)
    try {
      const result = await importTransactions(accountId as UUID, rows)
      // Refresh every supabase-backed query (transactions lists, spending plan, …).
      await qc.invalidateQueries({ queryKey: ['sb'] })
      toast.success(
        `Imported ${result.inserted} transaction${result.inserted === 1 ? '' : 's'}` +
          (result.duplicates > 0 ? `, skipped ${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'}` : ''),
      )
      // Best-effort credit auto-detection against the freshly imported rows.
      // Never breaks the import flow: failures stay silent.
      try {
        const detected = await detectCreditsAfterImport()
        if (detected > 0) {
          toast.success(
            `${detected} credit${detected === 1 ? '' : 's'} auto-detected as used`,
          )
          await qc.invalidateQueries({ queryKey: ['sb', 'churning'] })
        }
      } catch {
        /* detection is optional — the import already succeeded */
      }
      // Best-effort AI categorization of the freshly imported rows (rules and
      // merchant memory apply first; the backend never raises). Silent unless
      // it actually categorized something.
      try {
        const stats = await autoCategorize()
        if (stats && (stats.rules_applied > 0 || stats.ai_applied > 0 || stats.from_cache > 0)) {
          const n = stats.rules_applied + stats.ai_applied + stats.from_cache
          toast.success(`Auto-categorized ${n} transaction${n === 1 ? '' : 's'}`)
          await qc.invalidateQueries({ queryKey: ['sb'] })
        }
      } catch {
        /* categorization is optional — the import already succeeded */
      }
      reset()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.')
    } finally {
      setImporting(false)
    }
  }

  const headers = parsed?.headers ?? []

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset()
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import transactions from CSV</DialogTitle>
          <DialogDescription>
            For bank exports when Plaid sync isn't available. Parsed in your browser —
            nothing leaves this device except the rows saved to your database.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="csv-account">Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="csv-account">
                <SelectValue placeholder="Choose a synced account" />
              </SelectTrigger>
              <SelectContent>
                {activeAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.mask ? ` ••${a.mask}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="csv-file">CSV file</Label>
            <Input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {fileName && (
              <p className="text-xs text-muted-foreground">
                {fileName} — {parsed?.rows.length ?? 0} rows
              </p>
            )}
          </div>

          {parsed && (
            <>
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    ['Date', dateCol, setDateCol],
                    ['Amount', amountCol, setAmountCol],
                    ['Merchant / description', merchantCol, setMerchantCol],
                  ] as const
                ).map(([label, value, setValue]) => (
                  <div key={label} className="flex flex-col gap-1.5">
                    <Label>{label}</Label>
                    <Select value={value} onValueChange={setValue}>
                      <SelectTrigger>
                        <SelectValue placeholder="Column…" />
                      </SelectTrigger>
                      <SelectContent>
                        {headers.map((h) => (
                          <SelectItem key={h} value={h}>
                            {h || '(blank header)'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={spendNegative}
                  onCheckedChange={(v) => setSpendNegative(v === true)}
                />
                Spending shown as negative in this file (typical bank export)
              </label>

              {mappedRows.length > 0 && (
                <div className="rounded-md border border-border p-3 text-sm">
                  <p className="font-medium">
                    {validCount} row{validCount === 1 ? '' : 's'} ready
                    {skippedCount > 0 && (
                      <span className="text-muted-foreground">
                        {' '}
                        — {skippedCount} skipped (bad date/amount/merchant)
                      </span>
                    )}
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {mappedRows
                      .filter((r) => !r.skipped)
                      .slice(0, 5)
                      .map((r, i) => (
                        <li key={i}>
                          {r.date} · {r.merchant} ·{' '}
                          {r.amount >= 0 ? '' : '−'}${Math.abs(r.amount).toFixed(2)}{' '}
                          {r.amount >= 0 ? 'spent' : 'income'}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onImport()} disabled={importing || validCount === 0}>
            <Upload aria-hidden="true" className="mr-2 h-4 w-4" />
            {importing ? 'Importing…' : `Import ${validCount} row${validCount === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
