// Churning — card list. Each card tracks signup/retention bonuses, recurring
// credits, annual fees, and cancel-by dates. Spend progress against bonuses is
// measured from real transactions on the card's linked account (see detail page).

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarX2, CreditCard, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  useAccounts,
  useAllChurnBonuses,
  useAllChurnCredits,
  useBonusesQualifyingSpend,
  useChurnCards,
  useCreateChurnCard,
  useDeleteChurnCard,
  useUpdateChurnCard,
} from '@/data/hooks'
import {
  bonusProgress,
  bonusWindow,
  buildChurnDeadlines,
  cardIdentityLine,
  creditDaysLeft,
  creditNeedsAttention,
  creditRemaining,
  daysUntil,
} from '@/lib/churning'
import type { QualifyingWindow } from '@/data/churning'
import { ProgressBar } from '@/components/finance/ProgressBar'
import type { ChurnBonus, ChurnCard, ChurnCardInsert, ChurnCredit, UUID } from '@/types/domain'
import { formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

export default function ChurningPage() {
  const { data: cards = [], isLoading } = useChurnCards()
  const { data: bonuses = [] } = useAllChurnBonuses()
  const { data: credits = [] } = useAllChurnCredits()
  const [addOpen, setAddOpen] = useState(false)

  // Nearest upcoming deadline per card id → badge on the row.
  const deadlineByCard = useMemo(() => {
    const map = new Map<UUID, string>()
    for (const d of buildChurnDeadlines(cards, bonuses, credits)) {
      if (!map.has(d.cardId)) map.set(d.cardId, d.date)
    }
    return map
  }, [cards, bonuses, credits])

  // Unused credits whose reset is inside their own reminder window.
  const attentionCredits = useMemo(
    () => credits.filter((c) => creditNeedsAttention(c)),
    [credits],
  )

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Card churning
        </h1>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          Add card
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading cards…</p>
      ) : cards.length === 0 ? (
        <section className="card-surface p-8 text-center">
          <CreditCard className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <h2 className="mt-3 text-lg font-semibold text-foreground">No cards tracked yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Add a credit card to track its signup bonus spend requirement, recurring
            credits, annual fee, and when to call to cancel.
          </p>
          <Button className="mt-4" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Add your first card
          </Button>
        </section>
      ) : (
        <>
          <CardsThatNeedToBeUsed cards={cards} bonuses={bonuses} />
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {cards.map((card) => (
              <CardRow key={card.id} card={card} deadline={deadlineByCard.get(card.id) ?? null} />
            ))}
          </ul>
        </>
      )}

      {attentionCredits.length > 0 && (
        <section aria-label="Credits needing attention">
          <h2 className="mb-3 text-lg font-semibold tracking-tight text-foreground">
            Credits needing attention
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {attentionCredits.map((c) => (
              <AttentionCreditRow key={c.id} credit={c} />
            ))}
          </ul>
        </section>
      )}

      <CardDialog open={addOpen} onOpenChange={setAddOpen} card={null} />
    </div>
  )
}

/** Combined household "cards that need to be used": every in-progress signup
 *  bonus ordered by nearest deadline. Shows the physical-card identity
 *  (name + last5 + owner), the requirement, qualifying spend so far (same
 *  logic as the card detail page), remaining, deadline, and a progress bar —
 *  neutral numbers only, no per-day figures or pace labels. */
function CardsThatNeedToBeUsed({
  cards,
  bonuses,
}: {
  cards: ChurnCard[]
  bonuses: ChurnBonus[]
}) {
  const inProgress = useMemo(
    () => bonuses.filter((b) => b.status === 'in_progress' && daysUntil(b.spend_by_date) >= 0),
    [bonuses],
  )

  const windows = useMemo<QualifyingWindow[]>(
    () =>
      inProgress.flatMap((b) => {
        const card = cards.find((c) => c.id === b.card_id)
        const win = card ? bonusWindow(card, b) : null
        if (!card?.account_id || !win) return []
        return [{ key: b.id, accountId: card.account_id, startDate: win.start, endDate: win.end }]
      }),
    [inProgress, cards],
  )
  const { data: spendByBonus } = useBonusesQualifyingSpend(windows)

  const items = useMemo(
    () =>
      inProgress
        .map((b) => {
          const card = cards.find((c) => c.id === b.card_id)
          const progress = bonusProgress(b, spendByBonus?.get(b.id) ?? 0)
          return {
            bonus: b,
            card,
            progress,
            tracked: windows.some((w) => w.key === b.id),
          }
        })
        .sort((a, b2) => a.progress.daysLeft - b2.progress.daysLeft),
    [inProgress, cards, spendByBonus, windows],
  )

  if (items.length === 0) return null

  return (
    <section aria-label="Cards that need to be used">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-foreground">
        Cards that need to be used
      </h2>
      <ul className="space-y-3">
        {items.map(({ bonus, card, progress, tracked }) => (
          <li key={bonus.id}>
            <Link
              to={`/churning/${bonus.card_id}`}
              className="card-surface block p-4 transition-colors hover:bg-accent"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {card ? cardIdentityLine(card) : 'Card'}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {bonus.description}
                    {!tracked && ' · link an account on the card to track spend'}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
                    progress.daysLeft <= 14
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-surface-container-high text-muted-foreground',
                  )}
                >
                  {formatShortDate(bonus.spend_by_date)}
                  {' · '}
                  {progress.daysLeft === 0
                    ? 'Due today'
                    : `${progress.daysLeft}d left`}
                </span>
              </div>
              <div className="mt-3">
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Requirement <strong className="tabular-nums text-foreground">{formatCurrency(progress.required)}</strong>
                  </span>
                  <span>
                    Spent <strong className="tabular-nums text-foreground">{formatCurrency(progress.spent)}</strong>
                  </span>
                  <span>
                    Remaining{' '}
                    <strong className={cn('tabular-nums', progress.remaining > 0 ? 'text-destructive' : 'text-money-income')}>
                      {formatCurrency(progress.remaining)}
                    </strong>
                  </span>
                </div>
                <div className="mt-2">
                  <ProgressBar
                    value={progress.fraction * 100}
                    label={`${bonus.description} spend progress`}
                  />
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function AttentionCreditRow({ credit }: { credit: ChurnCredit }) {
  const left = creditDaysLeft(credit)
  const remaining = creditRemaining(credit)
  return (
    <li>
      <Link
        to={`/churning/${credit.card_id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{credit.credit_name}</p>
          <p className="text-xs text-muted-foreground">
            {credit.churn_cards?.card_name ?? 'Card'} · {formatCurrency(remaining)} unused
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
            left != null && left <= 14
              ? 'bg-destructive/10 text-destructive'
              : 'bg-surface-container-high text-muted-foreground',
          )}
        >
          {left == null
            ? 'No reset date'
            : left < 0
              ? 'Overdue'
              : left === 0
                ? 'Resets today'
                : `${left}d left`}
        </span>
      </Link>
    </li>
  )
}

function CardRow({ card, deadline }: { card: ChurnCard; deadline: string | null }) {
  const deleteCard = useDeleteChurnCard()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const left = deadline != null ? daysUntil(deadline) : null

  return (
    <li className="card-surface relative p-5">
      <Link to={`/churning/${card.id}`} className="block">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-foreground">{card.card_name}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {[
                card.last5 ? `••••• ${card.last5}` : card.last4 ? `•••• ${card.last4}` : null,
                card.owner_name,
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </p>
          </div>
          {left != null && (
            <span
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
                left <= 14
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-surface-container-high text-muted-foreground',
              )}
            >
              <CalendarX2 className="h-3.5 w-3.5" aria-hidden />
              {left === 0 ? 'Due today' : `${left}d`}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {card.annual_fee != null && (
            <span>
              Fee {formatCurrency(Number(card.annual_fee))}
              {card.annual_fee_date ? ` · ${formatShortDate(card.annual_fee_date)}` : ''}
            </span>
          )}
          {card.cancel_by_date && <span>Cancel by {formatShortDate(card.cancel_by_date)}</span>}
        </div>
      </Link>
      {confirmDelete ? (
        <div className="mt-3 flex gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              toast.promise(deleteCard.mutateAsync(card.id), {
                loading: `Deleting ${card.card_name}…`,
                success: `${card.card_name} deleted`,
                error: (e) => (e instanceof Error ? e.message : 'Could not delete card'),
              })
            }}
          >
            Confirm delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label={`Delete ${card.card_name}`}
          className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      )}
    </li>
  )
}

/** Create / edit a card. Used by both the list and the detail page. */
export function CardDialog({
  open,
  onOpenChange,
  card,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: ChurnCard | null
}) {
  const { data: accounts = [] } = useAccounts()
  const [name, setName] = useState(card?.card_name ?? '')
  const [issuer, setIssuer] = useState(card?.issuer ?? '')
  const [last4, setLast4] = useState(card?.last4 ?? '')
  const [last5, setLast5] = useState(card?.last5 ?? '')
  const [ownerName, setOwnerName] = useState(card?.owner_name ?? '')
  const [openedDate, setOpenedDate] = useState(card?.opened_date ?? '')
  const [annualFee, setAnnualFee] = useState(card?.annual_fee != null ? String(card.annual_fee) : '')
  const [annualFeeDate, setAnnualFeeDate] = useState(card?.annual_fee_date ?? '')
  const [cancelBy, setCancelBy] = useState(card?.cancel_by_date ?? '')
  const [accountId, setAccountId] = useState<string>(card?.account_id ?? '')
  const [notes, setNotes] = useState(card?.notes ?? '')
  const createCard = useCreateChurnCard()
  const updateCard = useUpdateChurnCard()
  const pending = createCard.isPending || updateCard.isPending

  async function save() {
    if (!name.trim()) {
      toast.error('Give the card a name.')
      return
    }
    const fee = annualFee.trim() === '' ? undefined : Number(annualFee)
    if (fee != null && (!Number.isFinite(fee) || fee < 0)) {
      toast.error('Annual fee must be a non-negative number.')
      return
    }
    const input: ChurnCardInsert = {
      card_name: name.trim(),
      issuer: issuer.trim() || undefined,
      last4: last4.trim() || undefined,
      last5: last5.trim() || undefined,
      owner_name: ownerName.trim() || undefined,
      opened_date: openedDate || undefined,
      annual_fee: fee,
      annual_fee_date: annualFeeDate || undefined,
      cancel_by_date: cancelBy || undefined,
      notes: notes.trim() || undefined,
      account_id: (accountId || undefined) as UUID | undefined,
    }
    // Create or update the card; the detail page reuses this dialog for edits.
    if (card) {
      await updateCard.mutateAsync({ id: card.id, patch: input })
      toast.success(`${input.card_name} updated`)
    } else {
      await createCard.mutateAsync(input)
      toast.success(`${input.card_name} added`)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{card ? 'Edit card' : 'Add card'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="card-name">Card name *</Label>
            <Input
              id="card-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sapphire Preferred"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-issuer">Issuer</Label>
            <Input
              id="card-issuer"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="e.g. Chase"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-last4">Last 4</Label>
            <Input
              id="card-last4"
              value={last4}
              onChange={(e) => setLast4(e.target.value)}
              inputMode="numeric"
              maxLength={4}
              placeholder="1234"
            />
            <p className="text-xs text-muted-foreground">Auto-filled from the linked account.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-last5">Last 5</Label>
            <Input
              id="card-last5"
              value={last5}
              onChange={(e) => setLast5(e.target.value)}
              inputMode="numeric"
              maxLength={5}
              placeholder="12345"
            />
            <p className="text-xs text-muted-foreground">
              Plaid only exposes 4 — enter the 5th digit once, manually.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-owner">Owner (full name)</Label>
            <Input
              id="card-owner"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder="e.g. Daniel"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-opened">Opened date</Label>
            <Input
              id="card-opened"
              type="date"
              value={openedDate}
              onChange={(e) => setOpenedDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-account">Linked account (for spend tracking)</Label>
            <select
              id="card-account"
              value={accountId}
              onChange={(e) => {
                const id = e.target.value
                setAccountId(id)
                // Plaid's mask only exposes the last 4 digits — fill them in;
                // the 5th digit stays a one-time manual entry.
                const acct = accounts.find((a) => a.id === id)
                if (acct?.mask) setLast4(acct.mask)
              }}
              className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">Not linked</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-fee">Annual fee ($)</Label>
            <Input
              id="card-fee"
              inputMode="decimal"
              value={annualFee}
              onChange={(e) => setAnnualFee(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-fee-date">Fee date</Label>
            <Input
              id="card-fee-date"
              type="date"
              value={annualFeeDate}
              onChange={(e) => setAnnualFeeDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-cancel">Cancel by</Label>
            <Input
              id="card-cancel"
              type="date"
              value={cancelBy}
              onChange={(e) => setCancelBy(e.target.value)}
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="card-notes">Notes</Label>
            <Input
              id="card-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. downgrade to no-fee after year 1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : card ? 'Save' : 'Add card'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
