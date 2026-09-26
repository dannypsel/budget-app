// Conditional category-rules management — the web counterpart of iOS CategoryRulesView.
// A rule matches a keyword ("description contains") and, optionally, a money direction and
// an amount range; when it fires it can set a category and/or flag the txn as a reimbursement
//. Legacy keyword→category rules are the null-condition case and still work.
// Lists rules human-readably (e.g. `"Ved Rao" · money in · > $1,500 → Rent + reimbursement`),
// adds one from the builder, and deletes per row. Inline-row style shared with the other
// Manage* dialogs.

import { useState } from 'react'
import { Plus, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CategoryIcon } from './CategoryIcon'
import {
  useAddRule,
  useAutoCategorizeUncategorized,
  useCategories,
  useDeleteRule,
  useRules,
} from '@/data/hooks'
import { describeRule } from '@/lib/categorySuggester'
import type { Category, RuleDirection } from '@/types/domain'
import { cn } from '@/lib/utils'

// Same input/focus recipe as the other Manage* dialogs (search-input focus ring).
const inputClass =
  'flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary'
const selectClass =
  'rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary'

type AmountMode = 'any' | 'over' | 'under' | 'between'

export function ManageRulesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { data: rules = [] } = useRules()
  const { data: categories = [] } = useCategories()
  const addRule = useAddRule()
  const del = useDeleteRule()
  const autoCategorize = useAutoCategorizeUncategorized()

  const [keyword, setKeyword] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [direction, setDirection] = useState<'any' | RuleDirection>('any')
  const [amountMode, setAmountMode] = useState<AmountMode>('any')
  const [minStr, setMinStr] = useState('')
  const [maxStr, setMaxStr] = useState('')
  const [reimburse, setReimburse] = useState(false)

  const byId = new Map<string, Category>(categories.map((c) => [c.id, c]))

  const min = amountMode === 'over' || amountMode === 'between' ? Number(minStr) : NaN
  const max = amountMode === 'under' || amountMode === 'between' ? Number(maxStr) : NaN
  const amountValid =
    amountMode === 'any' ||
    (amountMode === 'over' && minStr !== '' && min >= 0) ||
    (amountMode === 'under' && maxStr !== '' && max >= 0) ||
    (amountMode === 'between' && minStr !== '' && maxStr !== '' && min >= 0 && max >= min)
  // At least one action (a category or the reimbursement flag), a keyword, and valid amounts.
  const canAdd = keyword.trim() !== '' && (categoryId !== '' || reimburse) && amountValid

  function reset() {
    setKeyword('')
    setCategoryId('')
    setDirection('any')
    setAmountMode('any')
    setMinStr('')
    setMaxStr('')
    setReimburse(false)
  }

  function add() {
    if (!canAdd) return
    addRule.mutate(
      {
        keyword: keyword.trim(),
        categoryId: categoryId || null,
        direction: direction === 'any' ? null : direction,
        minAmount: amountMode === 'over' || amountMode === 'between' ? min : null,
        maxAmount: amountMode === 'under' || amountMode === 'between' ? max : null,
        setReimbursement: reimburse,
      },
      { onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not add rule') },
    )
    reset()
  }

  function runAutoCategorize() {
    autoCategorize.mutate(undefined, {
      onSuccess: (count) =>
        toast.success(
          count === 0
            ? 'Nothing to categorize — every transaction is already sorted or has no confident match.'
            : `Categorized ${count} transaction${count === 1 ? '' : 's'}.`,
        ),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Auto-categorize failed'),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto rounded-xl border-0 bg-card shadow-card-hover">
        <DialogHeader>
          <DialogTitle className="text-xl font-medium leading-7 text-foreground">
            Auto Classify
          </DialogTitle>
        </DialogHeader>

        {/* Auto-categorize (WEB-18): bulk-apply merchant memory + rules to every uncategorized
            txn. Mirrors iOS CategoryRulesView's top action. */}
        <div className="mb-2 mt-2 space-y-2 rounded-xl bg-surface-container-low p-3">
          <button
            type="button"
            onClick={runAutoCategorize}
            disabled={autoCategorize.isPending}
            className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-60 motion-reduce:transition-none"
          >
            <Wand2 aria-hidden className="h-4 w-4" />
            {autoCategorize.isPending ? 'Categorizing…' : 'Auto-categorize uncategorized'}
          </button>
          <p className="text-xs text-muted-foreground">
            Uses what you&rsquo;ve taught the app (per-merchant) plus your rules. Categorizing a
            transaction teaches it automatically.
          </p>
        </div>

        <div className="space-y-2">
          {rules.length === 0 && (
            <p className="px-1 text-sm text-muted-foreground">
              No rules yet. Most categorizing is learned automatically — add a rule only for a
              pattern you always want handled a certain way.
            </p>
          )}
          {rules.map((r) => {
            const cat = r.category_id ? byId.get(r.category_id) : null
            return (
              <div key={r.id} className="flex items-center gap-2 rounded-lg p-1">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {describeRule(r, cat?.name ?? null)}
                </span>
                {cat && <CategoryIcon category={cat} size={20} />}
                <button
                  type="button"
                  onClick={() => del.mutate(r.id)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-error-container hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none"
                  aria-label={`Delete rule for ${r.keyword}`}
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>

        {/* ── Rule builder ─────────────────────────────────────────────── */}
        <div className="mt-2 space-y-3 rounded-xl bg-surface-container-low p-3">
          <p className="text-sm font-medium text-foreground">New rule</p>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Description contains</span>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="e.g. Ved Rao, Whole Foods"
              aria-label="Rule keyword"
              className={cn(inputClass, 'w-full')}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Money direction</span>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'any' | RuleDirection)}
              aria-label="Money direction"
              className={cn(selectClass, 'w-full')}
            >
              <option value="any">Any</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </select>
          </label>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Amount</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={amountMode}
                onChange={(e) => setAmountMode(e.target.value as AmountMode)}
                aria-label="Amount condition"
                className={selectClass}
              >
                <option value="any">Any</option>
                <option value="over">Over</option>
                <option value="under">Under</option>
                <option value="between">Between</option>
              </select>
              {(amountMode === 'over' || amountMode === 'between') && (
                <input
                  value={minStr}
                  onChange={(e) => setMinStr(e.target.value)}
                  inputMode="decimal"
                  placeholder={amountMode === 'between' ? 'Min' : 'Amount'}
                  aria-label="Minimum amount"
                  className={cn(inputClass, 'w-24 flex-none')}
                />
              )}
              {amountMode === 'between' && <span className="text-sm text-muted-foreground">–</span>}
              {(amountMode === 'under' || amountMode === 'between') && (
                <input
                  value={maxStr}
                  onChange={(e) => setMaxStr(e.target.value)}
                  inputMode="decimal"
                  placeholder={amountMode === 'between' ? 'Max' : 'Amount'}
                  aria-label="Maximum amount"
                  className={cn(inputClass, 'w-24 flex-none')}
                />
              )}
            </div>
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Set category</span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              aria-label="Rule category"
              className={cn(selectClass, 'w-full')}
            >
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={reimburse}
              onChange={(e) => setReimburse(e.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            Mark as reimbursement
          </label>

          <button
            type="button"
            onClick={add}
            disabled={!canAdd || addRule.isPending}
            className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50 motion-reduce:transition-none"
          >
            <Plus aria-hidden className="h-4 w-4" /> Add rule
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
