// Grid category picker with a "None" option — mirrors iOS CategoryPickerSheet.
// When the transaction is already a transfer, shows a focused transfer view instead
// (no categories — those don't apply to transfers). Transfer linking/unlinking lives
// on the Transactions → Transfers tab.

import { useMemo, useState } from 'react'
import { ArrowRight, Eye, EyeOff, MapPin, Plus, Undo2, XCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { CategoryIcon } from './CategoryIcon'
import { useAccountsWithBalance, useCategories, useSetExcludeFromTotals, useSetHidden, useSetReimbursement, useTransferGroupLegs, useUnlinkTransfer, useUpsertCategory } from '@/data/hooks'
import { toast } from 'sonner'
import { TAG_PALETTE } from '@/lib/tagColors'
import { displayName, isForeignCurrency, isReimbursement, isTransfer, merchantLocation, type Transaction, type UUID } from '@/types/domain'
import { formatAmount, formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { summarizeTransferGroup } from '@/data/transfers'
import { TransactionDetails } from './TransactionDetails'
import { categoryForest, flattenForest } from '@/lib/categoryTree'

export function CategoryPickerDialog({
  txn,
  open,
  onOpenChange,
  onPick,
  onToggleHidden,
}: {
  txn: Transaction | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (categoryId: UUID | null) => void
  /** Called after the Hidden tile fires (hosts advance queues etc.). */
  onToggleHidden?: () => void
}) {
  const { data: categories = [] } = useCategories()
  const setHidden = useSetHidden()
  const setReimbursement = useSetReimbursement()
  const setExcludeFromTotals = useSetExcludeFromTotals()
  const unlinkTransfer = useUnlinkTransfer()
  const upsertCategory = useUpsertCategory()
  const [adding, setAdding] = useState(false)
  const [catQuery, setCatQuery] = useState('')
  const forest = useMemo(() => categoryForest(categories.filter((c) => c.is_active !== false)), [categories])
  const [newName, setNewName] = useState('')

  // When the txn is already a transfer, fetch its group legs so we can render the route.
  const { data: groupLegs } = useTransferGroupLegs(txn && isTransfer(txn) ? txn.transfer_group_id : null)
  const { data: accountsData } = useAccountsWithBalance()
  const accountsById = useMemo(
    () => new Map((accountsData ?? []).map((a) => [a.id, a])),
    [accountsData],
  )
  const transferSummary = useMemo(
    () => (groupLegs && groupLegs.length > 0 ? summarizeTransferGroup(groupLegs, accountsById) : null),
    [groupLegs, accountsById],
  )

  // A reimbursement is an incoming credit (amount < 0) that offsets a category's spend.
  // The toggle is only meaningful for credits; picking a category while it's on marks
  // the txn as a reimbursement for that category instead of a normal categorization.
  const isCredit = txn != null && txn.amount < 0
  const [reimbursing, setReimbursing] = useState(() => (txn ? isReimbursement(txn) : false))
  // Re-seed the toggle from the txn whenever a different one is shown (the dialog is a
  // single reused instance). React's recommended render-phase "reset on prop change".
  const [lastTxnId, setLastTxnId] = useState(txn?.id ?? null)
  if ((txn?.id ?? null) !== lastTxnId) {
    setLastTxnId(txn?.id ?? null)
    setReimbursing(txn ? isReimbursement(txn) : false)
  }

  /** Route a category choice: in reimbursement mode mark the contra-expense (needs a
   *  real category); otherwise the normal categorize path. */
  function commitCategory(categoryId: UUID | null) {
    if (reimbursing && txn) {
      if (!categoryId) return // a reimbursement must offset a category — ignore "None"
      setReimbursement.mutate({ transactionId: txn.id, isReimbursement: true, categoryId })
      onOpenChange(false)
      return
    }
    onPick(categoryId)
  }

  /** Toggle reimbursement mode. Turning it off on an already-flagged txn unmarks it now
   *  (keeping its category as a normal credit); turning it on waits for a category pick. */
  function toggleReimbursing(on: boolean) {
    if (!txn) return
    setReimbursing(on)
    if (!on && isReimbursement(txn)) {
      // Un-flagging clears the category — the row reverts to a plain uncategorized
      // credit (parity with iOS; the data layer enforces this too)
      setReimbursement.mutate({
        transactionId: txn.id,
        isReimbursement: false,
        categoryId: null,
      })
      onOpenChange(false)
    }
  }

  /** Simplifi's "Exclude from spending plan and reports" — flips exclude_from_totals directly. Hidden and
   *  transfer legs are always excluded by their own flows, so the toggle is only
   *  offered on plain visible rows. */
  function toggleIgnored(exclude: boolean) {
    if (!txn) return
    setExcludeFromTotals.mutate({ transactionId: txn.id, exclude })
  }

  /** Create the category and immediately assign it to the txn. */
  async function createAndPick() {
    const name = newName.trim()
    if (!name) return
    const created = await upsertCategory.mutateAsync({
      name,
      color: TAG_PALETTE[categories.length % TAG_PALETTE.length],
      icon: 'tag.fill',
      sort_order: categories.length,
    })
    setNewName('')
    setAdding(false)
    commitCategory(created.id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">

        {txn && isTransfer(txn) ? (
          // ── Transfer view — transfers don't have categories ──
          <>
            <DialogHeader>
              <DialogTitle>Transfer</DialogTitle>
            </DialogHeader>

            {/* Transaction identity */}
            <div className="rounded-lg bg-surface-container-low px-3 py-2 text-sm">
              <p className="break-words font-medium text-foreground">{displayName(txn)}</p>
              <p className="mt-0.5 text-muted-foreground">
                {formatShortDate(txn.effective_date)} · {formatAmount(txn.amount)}
              </p>
            </div>

            {/* From → To route */}
            {transferSummary ? (
              <div className="rounded-lg border border-border bg-surface-container-low px-4 py-3">
                <p className="text-base font-semibold tabular-nums text-foreground">
                  {formatCurrency(transferSummary.amount)}
                </p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  <span className="break-words">
                    {transferSummary.from ?? transferSummary.external ?? 'External'}
                  </span>
                  <ArrowRight className="mx-1 inline h-3.5 w-3.5 shrink-0 align-middle text-muted-foreground" aria-hidden="true" />
                  <span className="break-words">
                    {transferSummary.to ?? transferSummary.external ?? 'External'}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Excluded from spending plan and reports</p>
              </div>
            ) : (
              <p className="px-1 text-sm text-muted-foreground">Loading transfer details…</p>
            )}
            {/* Simplifi lets a "transfer" count in reports. Unlinking puts both legs back
                into totals (and stops auto-detection re-linking them); the row can then
                be categorized — e.g. Churning › Credit Sales. */}
            {txn.transfer_group_id && (
              <button
                type="button"
                disabled={unlinkTransfer.isPending}
                onClick={() =>
                  unlinkTransfer.mutate(txn.transfer_group_id!, {
                    onSuccess: () => {
                      toast.success('Not a transfer anymore — it now counts in reports. Open it again to categorize it.')
                      onOpenChange(false)
                    },
                    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not unlink'),
                  })
                }
                className="flex w-full items-start gap-3 rounded-lg bg-surface-container-low px-3 py-2.5 text-left hover:bg-accent disabled:opacity-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                  <Eye className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">Not a transfer — include in reports</span>
                  <span className="block text-xs text-muted-foreground">
                    Unlinks both sides so they count as spending or income again
                  </span>
                </span>
              </button>
            )}
          </>
        ) : (
          // ── Normal categorize view ───────────────────────────────────────────
          <>
            <DialogHeader>
              <DialogTitle>Categorize</DialogTitle>
            </DialogHeader>
            {txn && (
              <div className="mb-2 rounded-lg bg-surface-container-low px-3 py-2 text-sm">
                <p className="break-words font-medium text-foreground">{displayName(txn)}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {formatShortDate(txn.effective_date)} · {formatAmount(txn.amount)}
                </p>
                {/* Plaid merchant location + foreign-currency badge — shown only
                    when Plaid resolved them; historical rows stay blank until a re-sync. */}
                {(merchantLocation(txn) || isForeignCurrency(txn)) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {merchantLocation(txn) && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {merchantLocation(txn)}
                      </span>
                    )}
                    {isForeignCurrency(txn) && (
                      <span
                        title="Foreign transaction"
                        className="inline-flex items-center rounded-full bg-secondary-container px-2 py-0.5 text-xs font-semibold text-on-secondary-container"
                      >
                        {txn.iso_currency_code}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Reimbursement (contra-expense) — only for credits. When on, the category grid
                below picks the category this credit offsets instead of categorizing it. */}
            {isCredit && (
              <label className="mb-1 flex items-start gap-3 rounded-lg bg-surface-container-low px-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                  <Undo2 className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">Reimbursement</span>
                  <span className="block text-xs text-muted-foreground">
                    {reimbursing
                      ? 'Pick the category this offsets below'
                      : 'Offsets a category\u2019s spend instead of counting as income'}
                  </span>
                </span>
                <Switch
                  checked={reimbursing}
                  onCheckedChange={toggleReimbursing}
                  aria-label="Reimbursement"
                  className="mt-0.5"
                />
              </label>
            )}
            {/* Exclude from spending plan and reports — flips exclude_from_totals, the same flag every
                totals query filters on. Hidden and transfer legs are always excluded, so
                the toggle only applies to plain visible rows. */}
            {txn && !txn.hidden && !isTransfer(txn) && (
              <label className="mb-1 flex items-start gap-3 rounded-lg bg-surface-container-low px-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                  <EyeOff className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    Exclude from spending plan and reports
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Leaves it out of spending, income and reports without hiding it
                  </span>
                </span>
                <Switch
                  checked={txn.exclude_from_totals}
                  onCheckedChange={toggleIgnored}
                  aria-label="Exclude from spending plan and reports"
                  className="mt-0.5"
                />
              </label>
            )}
            {/* Simplifi-style tree: each top-level category with its subcategories. */}
            <input
              value={catQuery}
              onChange={(e) => setCatQuery(e.target.value)}
              placeholder="Search categories"
              aria-label="Search categories"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
            />
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {forest.map((node) => {
                const q = catQuery.trim().toLowerCase()
                const kids = flattenForest(node.children)
                const parentHit = !q || node.category.name.toLowerCase().includes(q)
                const shownKids = q && !parentHit ? kids.filter((k) => k.category.name.toLowerCase().includes(q)) : kids
                if (!parentHit && shownKids.length === 0) return null
                return (
                  <div key={node.category.id}>
                    <button
                      onClick={() => commitCategory(node.category.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <CategoryIcon category={node.category} />
                      <span className="text-sm font-medium">{node.category.name}</span>
                    </button>
                    {shownKids.length > 0 && (
                      <div className="ml-11 flex flex-wrap gap-1.5 pb-1.5">
                        {shownKids.map(({ category: c, depth }) => (
                          <button
                            key={c.id}
                            onClick={() => commitCategory(c.id)}
                            className="rounded-full border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            {depth > 1 ? '› ' : ''}
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {/* "None" clears the category — meaningless for a reimbursement (it must offset
                  one), so hide it while reimbursing. */}
              {!reimbursing && (
                <button
                  onClick={() => commitCategory(null)}
                  className="flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                    <XCircle className="h-4 w-4" />
                  </div>
                  <span className="text-center text-xs leading-tight">None</span>
                </button>
              )}
              {/* Hidden behaves like a bucket: keeps the txn (and its category) but drops
                  it from totals. Picking a regular category on a hidden txn unhides it. */}
              {txn && (
                <button
                  onClick={() => {
                    setHidden.mutate({ txn, hidden: !txn.hidden })
                    onOpenChange(false)
                    onToggleHidden?.()
                  }}
                  className="flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-muted-foreground">
                    {txn.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </div>
                  <span className="text-center text-xs leading-tight">
                    {txn.hidden ? 'Unhide' : 'Hidden'}
                  </span>
                </button>
              )}
              <button
                onClick={() => setAdding((a) => !a)}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-outline-variant p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container text-primary">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="text-center text-xs leading-tight">New</span>
              </button>
            </div>
            {adding && (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createAndPick()}
                  placeholder="Category name…"
                  className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={createAndPick}
                  disabled={!newName.trim() || upsertCategory.isPending}
                  className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50 motion-reduce:transition-none"
                >
                  Add
                </button>
              </div>
            )}
            {txn && <TransactionDetails txn={txn} />}
          </>
        )}

      </DialogContent>
    </Dialog>
  )
}
