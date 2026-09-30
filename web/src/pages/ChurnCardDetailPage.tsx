// Card detail — one churn card's bonuses, credits, fees, and cancel-by date.
// Bonus progress counts real transactions on the card's linked account in the
// bonus window (COALESCE(spend_start_date, opened_date) → spend_by_date): only
// positive outflow amounts, excluding hidden/transfer rows. When no account is
// linked, progress shows as untracked and the card links to /accounts.

import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { ProgressBar } from '@/components/finance/ProgressBar'
import { CardDialog } from './ChurningPage'
import {
  useAccounts,
  useBonusQualifyingSpend,
  useChurnBonuses,
  useChurnCard,
  useChurnCredits,
  useCreateChurnBonus,
  useCreateChurnCredit,
  useDeleteChurnBonus,
  useDeleteChurnCard,
  useDeleteChurnCredit,
  useUpdateChurnBonus,
  useUpdateChurnCredit,
  useTransaction,
} from '@/data/hooks'
import {
  bonusProgress,
  bonusWindow,
  creditDaysLeft,
  creditFrequencyLabel,
  CHURN_CREDIT_FREQUENCY_LABELS,
  creditIsUsed,
  creditRemaining,
  creditUnusedPillText,
  parseKeywordList,
} from '@/lib/churning'
import type {
  ChurnBonus,
  ChurnBonusInsert,
  ChurnBonusStatus,
  ChurnCard,
  ChurnCredit,
  ChurnCreditFrequency,
  ChurnCreditInsert,
} from '@/types/domain'
import { displayName } from '@/types/domain'
import { formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<ChurnBonusStatus, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
}

export default function ChurnCardDetailPage() {
  const { cardId } = useParams<{ cardId: string }>()
  const navigate = useNavigate()
  const { data: card, isLoading } = useChurnCard(cardId ?? null)
  const { data: bonuses = [] } = useChurnBonuses(cardId ?? null)
  const { data: credits = [] } = useChurnCredits(cardId ?? null)
  const { data: accounts = [] } = useAccounts()
  const [editOpen, setEditOpen] = useState(false)
  const [bonusDialog, setBonusDialog] = useState<{ bonus: ChurnBonus | null } | null>(null)
  const [creditDialog, setCreditDialog] = useState<{ credit: ChurnCredit | null } | null>(null)
  const deleteCard = useDeleteChurnCard()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const accountName = useMemo(
    () => accounts.find((a) => a.id === card?.account_id)?.name ?? null,
    [accounts, card],
  )

  if (isLoading) return <p className="pt-8 text-sm text-muted-foreground">Loading card…</p>
  if (!card) {
    return (
      <div className="pt-8">
        <p className="text-sm text-muted-foreground">Card not found.</p>
        <Link to="/churning" className="mt-2 inline-block text-sm font-semibold text-primary hover:underline">
          Back to cards
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <Link
        to="/churning"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Cards
      </Link>

      {/* Header */}
      <section className="card-surface p-6 md:p-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {card.card_name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {[
                card.last5 ? `••••• ${card.last5}` : card.last4 ? `•••• ${card.last4}` : null,
                card.owner_name,
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1.5 h-4 w-4" aria-hidden />
              Edit
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    toast.promise(deleteCard.mutateAsync(card.id), {
                      loading: `Deleting ${card.card_name}…`,
                      success: `${card.card_name} deleted`,
                      error: (e) => (e instanceof Error ? e.message : 'Could not delete card'),
                    })
                    navigate('/churning')
                  }}
                >
                  Confirm
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
                Delete
              </Button>
            )}
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4 sm:grid-cols-4">
          <div>
            <dt className="eyebrow mb-0.5">Opened</dt>
            <dd className="text-sm font-semibold text-foreground">
              {card.opened_date ? formatShortDate(card.opened_date) : '—'}
            </dd>
          </div>
          <div>
            <dt className="eyebrow mb-0.5">Annual fee</dt>
            <dd className="text-sm font-semibold text-foreground">
              {card.annual_fee != null ? formatCurrency(Number(card.annual_fee)) : '—'}
              {card.annual_fee_date && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {formatShortDate(card.annual_fee_date)}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="eyebrow mb-0.5">Cancel by</dt>
            <dd className="text-sm font-semibold text-foreground">
              {card.cancel_by_date ? formatShortDate(card.cancel_by_date) : '—'}
            </dd>
          </div>
          <div>
            <dt className="eyebrow mb-0.5">Linked account</dt>
            <dd className="text-sm font-semibold text-foreground">
              {accountName ?? 'Not linked'}
            </dd>
          </div>
        </dl>
        {card.notes && (
          <p className="mt-4 text-sm text-muted-foreground">{card.notes}</p>
        )}
        {!card.account_id && (
          <p className="mt-4 rounded-lg bg-secondary-container/40 px-3 py-2 text-sm text-on-secondary-container">
            Link this card to a real account to track bonus spend from transactions.{' '}
            <button type="button" onClick={() => setEditOpen(true)} className="font-semibold underline">
              Link an account
            </button>
          </p>
        )}
      </section>

      {/* Bonuses */}
      <section className="card-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-medium leading-7 text-foreground">Bonuses</h2>
          <Button variant="ghost" size="sm" onClick={() => setBonusDialog({ bonus: null })}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Add
          </Button>
        </div>
        {bonuses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bonuses tracked — add a signup or retention bonus with its spend requirement.
          </p>
        ) : (
          <ul className="space-y-4">
            {bonuses.map((b) => (
              <BonusRow
                key={b.id}
                card={card}
                bonus={b}
                onEdit={() => setBonusDialog({ bonus: b })}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Credits */}
      <section className="card-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-medium leading-7 text-foreground">Credits</h2>
          <Button variant="ghost" size="sm" onClick={() => setCreditDialog({ credit: null })}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Add
          </Button>
        </div>
        {credits.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No credits tracked — add airline, dining, streaming, or other recurring card credits.
          </p>
        ) : (
          <ul className="space-y-4">
            {credits.map((c) => (
              <CreditRow key={c.id} credit={c} onEdit={() => setCreditDialog({ credit: c })} />
            ))}
          </ul>
        )}
      </section>

      {editOpen && (
        <CardDialog open card={card} onOpenChange={setEditOpen} />
      )}
      {bonusDialog && (
        <BonusDialog
          cardId={card.id}
          bonus={bonusDialog.bonus}
          onOpenChange={(o) => !o && setBonusDialog(null)}
        />
      )}
      {creditDialog && (
        <CreditDialog
          cardId={card.id}
          credit={creditDialog.credit}
          onOpenChange={(o) => !o && setCreditDialog(null)}
        />
      )}
    </div>
  )
}

// ─── Bonus row ──────────────────────────────────────────────────────────────

function BonusRow({
  card,
  bonus,
  onEdit,
}: {
  card: ChurnCard
  bonus: ChurnBonus
  onEdit: () => void
}) {
  const window = bonusWindow(card, bonus)
  const { data: qualifyingSpend = 0 } = useBonusQualifyingSpend(
    card.account_id,
    window?.start ?? null,
    window?.end ?? null,
  )
  const progress = useMemo(
    () => bonusProgress(bonus, qualifyingSpend),
    [bonus, qualifyingSpend],
  )
  const updateBonus = useUpdateChurnBonus()
  const deleteBonus = useDeleteChurnBonus()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tracked = card.account_id != null && window != null

  const cycleStatus = (next: ChurnBonusStatus) =>
    updateBonus.mutate({ id: bonus.id, patch: { status: next } })

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-foreground">{bonus.description}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {bonus.bonus_value ? `${bonus.bonus_value} · ` : ''}
            by {formatShortDate(bonus.spend_by_date)}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold',
            bonus.status === 'completed' && 'bg-income/10 text-income',
            bonus.status === 'failed' && 'bg-destructive/10 text-destructive',
            bonus.status === 'in_progress' && 'bg-secondary-container text-on-secondary-container',
          )}
        >
          {STATUS_LABEL[bonus.status]}
        </span>
      </div>

      {tracked ? (
        <div className="mt-3">
          <ProgressBar
            value={Math.min(100, progress.fraction * 100)}
            fillClassName={progress.remaining === 0 ? 'bg-income' : 'bg-primary'}
            label={`${bonus.description} spend progress`}
          />
          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span className="tabular-nums">
              {formatCurrency(progress.spent)} of {formatCurrency(progress.required)} ·{' '}
              {formatCurrency(progress.remaining)} left
            </span>
            <span
              className={cn(
                'font-semibold tabular-nums',
                progress.daysLeft <= 14 && 'text-destructive',
              )}
            >
              {progress.daysLeft < 0
                ? 'Window passed'
                : progress.daysLeft === 0
                  ? 'Ends today'
                  : `${progress.daysLeft}d left`}
            </span>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {!card.account_id
            ? 'Link an account to track spend automatically.'
            : 'Set the card opened date to anchor the spend window.'}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {bonus.status === 'in_progress' && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => cycleStatus('completed')}
              disabled={updateBonus.isPending}
            >
              Mark complete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cycleStatus('failed')}
              disabled={updateBonus.isPending}
              className="text-muted-foreground"
            >
              Missed
            </Button>
          </>
        )}
        {bonus.status !== 'in_progress' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => cycleStatus('in_progress')}
            disabled={updateBonus.isPending}
          >
            Reopen
          </Button>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${bonus.description}`}>
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          {confirmDelete ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                toast.promise(deleteBonus.mutateAsync(bonus.id), {
                  loading: 'Deleting bonus…',
                  success: 'Bonus deleted',
                  error: (e) => (e instanceof Error ? e.message : 'Could not delete bonus'),
                })
              }}
            >
              Confirm
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete ${bonus.description}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

// ─── Credit row ─────────────────────────────────────────────────────────────

/** Exported for tests. */
export function CreditRow({
  credit,
  onEdit,
}: {
  credit: ChurnCredit
  onEdit: () => void
}) {
  const remaining = creditRemaining(credit)
  const usedAmount = Number(credit.used_amount) || 0
  const fullAmount = Number(credit.amount) || 0
  const used = creditIsUsed(credit)
  const partial = !used && usedAmount > 0
  const daysLeft = creditDaysLeft(credit)
  const updateCredit = useUpdateChurnCredit()
  const deleteCredit = useDeleteChurnCredit()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [logging, setLogging] = useState(false)
  const [logAmount, setLogAmount] = useState('')
  // The latest transaction auto-detection matched (for the subtext link).
  const { data: detectedTxn } = useTransaction(
    credit.detection_source === 'auto' ? credit.detected_transaction_id : null,
  )

  const keywords = credit.detect_merchant_keywords ?? []
  const autoDetectOn = credit.auto_detect ?? true
  const manuallyTracked = credit.detection_source === 'manual'

  async function markFull() {
    await updateCredit.mutateAsync({
      id: credit.id,
      patch: {
        used_amount: fullAmount,
        detection_source: 'manual',
        used_at: new Date().toISOString(),
      },
    })
    toast.success(`"${credit.credit_name}" marked used`)
  }

  async function logSpend() {
    const amt = Math.round(Number(logAmount) * 100) / 100
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter an amount greater than $0')
      return
    }
    const next = Math.min(Math.round((usedAmount + amt) * 100) / 100, fullAmount)
    await updateCredit.mutateAsync({
      id: credit.id,
      patch: {
        used_amount: next,
        detection_source: 'manual',
        used_at: new Date().toISOString(),
      },
    })
    setLogging(false)
    setLogAmount('')
    toast.success(`Logged ${formatCurrency(amt)} toward "${credit.credit_name}"`)
  }

  async function resetUsage() {
    // Dismiss every contributing transaction so auto-detect won't re-mark them.
    const dismissed = [...(credit.detection_dismissed_transaction_ids ?? [])]
    for (const id of [...(credit.detected_transaction_ids ?? []), credit.detected_transaction_id]) {
      if (id && !dismissed.includes(id)) dismissed.push(id)
    }
    await updateCredit.mutateAsync({
      id: credit.id,
      patch: {
        used_amount: 0,
        used_at: null,
        detected_transaction_id: null,
        detected_transaction_ids: [],
        detection_source: null,
        detection_dismissed_transaction_ids: dismissed,
      },
    })
    toast.success(`"${credit.credit_name}" reset — auto-detect resumed`)
  }

  const pillClass = used
    ? credit.detection_source === 'auto'
      ? 'bg-income/10 text-income'
      : 'bg-secondary-container text-on-secondary-container'
    : partial
      ? 'bg-primary/10 text-primary'
      : daysLeft != null && daysLeft <= 14
        ? 'bg-destructive/10 text-destructive'
        : 'bg-surface-container-high text-muted-foreground'
  const pillText = used
    ? credit.detection_source === 'auto'
      ? 'Used · auto'
      : 'Used · manual'
    : partial
      ? 'Partially used'
      : creditUnusedPillText(credit)

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-foreground">{credit.credit_name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {creditFrequencyLabel(credit.frequency)}
            {credit.reset_date ? ` · resets ${formatShortDate(credit.reset_date)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', pillClass)}>
            {pillText}
          </span>
          <p className="text-xs text-muted-foreground tabular-nums">
            Spent {formatCurrency(usedAmount)} of {formatCurrency(fullAmount)}
          </p>
        </div>
      </div>

      {credit.detection_source === 'auto' && credit.detected_transaction_id && (
        <p className="mt-2 text-xs text-muted-foreground">
          {detectedTxn
            ? `${displayName(detectedTxn)} · ${formatCurrency(Math.abs(Number(detectedTxn.amount)))} · ${formatShortDate(detectedTxn.date)}`
            : 'Matched transaction'}
          {detectedTxn && (
            <>
              {' · '}
              <Link
                to={`/transactions?q=${encodeURIComponent(displayName(detectedTxn))}`}
                className="font-semibold text-primary hover:underline"
              >
                View transaction
              </Link>
            </>
          )}
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        {manuallyTracked ? (
          'Manual tracking · auto-detect paused (Reset to resume)'
        ) : autoDetectOn && keywords.length > 0 ? (
          <>
            Auto-detect: {keywords.join(', ')}
            {credit.detect_amount != null &&
              ` · ~${formatCurrency(Number(credit.detect_amount))}`}
          </>
        ) : (
          'Auto-detect off'
        )}
      </p>

      <div className="mt-3">
        <ProgressBar
          value={Math.min(100, (Number(credit.used_amount) / Math.max(1, Number(credit.amount))) * 100)}
          fillClassName={remaining === 0 ? 'bg-income' : 'bg-primary'}
          label={`${credit.credit_name} used`}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!used && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLogging((v) => !v)
                setLogAmount('')
              }}
              disabled={updateCredit.isPending}
            >
              Log spend
            </Button>
            <Button variant="outline" size="sm" onClick={() => void markFull()} disabled={updateCredit.isPending}>
              Mark full
            </Button>
          </>
        )}
        {usedAmount > 0 && (
          <Button variant="outline" size="sm" onClick={() => void resetUsage()} disabled={updateCredit.isPending}>
            Reset
          </Button>
        )}
        {logging && !used && (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              aria-label={`Amount spent toward ${credit.credit_name}`}
              placeholder="0.00"
              value={logAmount}
              onChange={(e) => setLogAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void logSpend()
              }}
              className="h-8 w-28"
            />
            <Button size="sm" onClick={() => void logSpend()} disabled={updateCredit.isPending}>
              Add
            </Button>
          </div>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${credit.credit_name}`}>
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          {confirmDelete ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                toast.promise(deleteCredit.mutateAsync(credit.id), {
                  loading: 'Deleting credit…',
                  success: 'Credit deleted',
                  error: (e) => (e instanceof Error ? e.message : 'Could not delete credit'),
                })
              }}
            >
              Confirm
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete ${credit.credit_name}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

// ─── Bonus dialog ───────────────────────────────────────────────────────────

function BonusDialog({
  cardId,
  bonus,
  onOpenChange,
}: {
  cardId: string
  bonus: ChurnBonus | null
  onOpenChange: (open: boolean) => void
}) {
  const [description, setDescription] = useState(bonus?.description ?? '')
  const [spendRequired, setSpendRequired] = useState(bonus ? String(bonus.spend_required) : '')
  const [spendStart, setSpendStart] = useState(bonus?.spend_start_date ?? '')
  const [spendBy, setSpendBy] = useState(bonus?.spend_by_date ?? '')
  const [bonusValue, setBonusValue] = useState(bonus?.bonus_value ?? '')
  const createBonus = useCreateChurnBonus()
  const updateBonus = useUpdateChurnBonus()
  const pending = createBonus.isPending || updateBonus.isPending

  async function save() {
    const required = Number(spendRequired)
    if (!description.trim() || !Number.isFinite(required) || required <= 0) {
      toast.error('Enter a description and a positive spend requirement.')
      return
    }
    if (!spendBy) {
      toast.error('Enter the spend-by date.')
      return
    }
    const input: ChurnBonusInsert = {
      card_id: cardId as ChurnBonus['card_id'],
      description: description.trim(),
      spend_required: required,
      spend_start_date: spendStart || undefined,
      spend_by_date: spendBy,
      bonus_value: bonusValue.trim() || undefined,
    }
    if (bonus) {
      await updateBonus.mutateAsync({ id: bonus.id, patch: input })
      toast.success('Bonus updated')
    } else {
      await createBonus.mutateAsync(input)
      toast.success('Bonus added')
    }
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{bonus ? 'Edit bonus' : 'Add bonus'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="bonus-desc">Description *</Label>
            <Input
              id="bonus-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. 80k points signup bonus"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bonus-req">Spend required ($) *</Label>
            <Input
              id="bonus-req"
              inputMode="decimal"
              value={spendRequired}
              onChange={(e) => setSpendRequired(e.target.value)}
              placeholder="4000"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bonus-value">Bonus value</Label>
            <Input
              id="bonus-value"
              value={bonusValue}
              onChange={(e) => setBonusValue(e.target.value)}
              placeholder="e.g. 80k points"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bonus-start">Spend window start</Label>
            <Input
              id="bonus-start"
              type="date"
              value={spendStart}
              onChange={(e) => setSpendStart(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Defaults to the card's opened date.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bonus-end">Spend by *</Label>
            <Input
              id="bonus-end"
              type="date"
              value={spendBy}
              onChange={(e) => setSpendBy(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : bonus ? 'Save' : 'Add bonus'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Credit dialog ──────────────────────────────────────────────────────────

const FREQUENCIES: { value: ChurnCreditFrequency; label: string }[] = (
  Object.keys(CHURN_CREDIT_FREQUENCY_LABELS) as ChurnCreditFrequency[]
).map((value) => ({ value, label: creditFrequencyLabel(value) }))

/** Exported for tests. */
export function CreditDialog({
  cardId,
  credit,
  onOpenChange,
}: {
  cardId: string
  credit: ChurnCredit | null
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(credit?.credit_name ?? '')
  const [amount, setAmount] = useState(credit ? String(credit.amount) : '')
  const [frequency, setFrequency] = useState<ChurnCreditFrequency>(credit?.frequency ?? 'annual')
  const [resetDate, setResetDate] = useState(credit?.reset_date ?? '')
  const [notes, setNotes] = useState(credit?.notes ?? '')
  // ── auto-detection ──
  const [autoDetect, setAutoDetect] = useState(credit?.auto_detect ?? true)
  const [keywords, setKeywords] = useState((credit?.detect_merchant_keywords ?? []).join(', '))
  const [detectAmount, setDetectAmount] = useState(
    credit?.detect_amount != null ? String(credit.detect_amount) : '',
  )
  const [tolerance, setTolerance] = useState(
    credit?.detect_tolerance != null ? String(credit.detect_tolerance) : '0.01',
  )
  const [remindDays, setRemindDays] = useState(
    credit?.remind_days_before != null ? String(credit.remind_days_before) : '7',
  )
  const createCredit = useCreateChurnCredit()
  const updateCredit = useUpdateChurnCredit()
  const pending = createCredit.isPending || updateCredit.isPending

  async function save() {
    const parsed = Number(amount)
    if (!name.trim() || !Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Enter a name and a positive credit amount.')
      return
    }
    const keywordList = parseKeywordList(keywords)
    if (autoDetect && keywordList.length === 0) {
      toast.error('Add at least one merchant keyword, or turn auto-detect off.')
      return
    }
    const detectAmt = detectAmount.trim() === '' ? undefined : Number(detectAmount)
    if (detectAmt !== undefined && (!Number.isFinite(detectAmt) || detectAmt <= 0)) {
      toast.error('Expected credit amount must be a positive number.')
      return
    }
    const tol = tolerance.trim() === '' ? 0.01 : Number(tolerance)
    if (!Number.isFinite(tol) || tol < 0) {
      toast.error('Match tolerance must be a non-negative number.')
      return
    }
    const remind = remindDays.trim() === '' ? 7 : Number(remindDays)
    if (!Number.isFinite(remind) || remind < 0 || !Number.isInteger(remind)) {
      toast.error('Reminder days must be a non-negative whole number.')
      return
    }
    const input: ChurnCreditInsert = {
      card_id: cardId as ChurnCredit['card_id'],
      credit_name: name.trim(),
      amount: parsed,
      frequency,
      reset_date: resetDate || undefined,
      notes: notes.trim() || undefined,
      auto_detect: autoDetect,
      detect_merchant_keywords: keywordList,
      detect_amount: detectAmt,
      detect_tolerance: tol,
      remind_days_before: remind,
    }
    if (credit) {
      await updateCredit.mutateAsync({ id: credit.id, patch: input })
      toast.success('Credit updated')
    } else {
      await createCredit.mutateAsync(input)
      toast.success('Credit added')
    }
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{credit ? 'Edit credit' : 'Add credit'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="credit-name">Name *</Label>
            <Input
              id="credit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Airline fee credit"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-amount">Amount ($) *</Label>
            <Input
              id="credit-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="200"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-freq">Frequency</Label>
            <select
              id="credit-freq"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as ChurnCreditFrequency)}
              className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-reset">Reset date</Label>
            <Input
              id="credit-reset"
              type="date"
              value={resetDate}
              onChange={(e) => setResetDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-notes">Notes</Label>
            <Input
              id="credit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. enroll first"
            />
          </div>

          {/* Auto-detection */}
          <div className="col-span-2 space-y-3 rounded-xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="credit-autodetect" className="text-sm font-semibold">
                  Auto-detect usage
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Match statement credits in imported/synced transactions and mark this
                  credit used automatically.
                </p>
              </div>
              <Switch
                id="credit-autodetect"
                checked={autoDetect}
                onCheckedChange={(v) => setAutoDetect(v === true)}
              />
            </div>
            {autoDetect && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="credit-keywords">Merchant keywords *</Label>
                  <Input
                    id="credit-keywords"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="grubhub, doordash"
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated — e.g. Amex Gold Business dining credit → keywords
                    "grubhub", amount 20.00. Detection can't run without at least one
                    keyword.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="credit-detect-amount">Expected credit amount ($)</Label>
                    <Input
                      id="credit-detect-amount"
                      inputMode="decimal"
                      value={detectAmount}
                      onChange={(e) => setDetectAmount(e.target.value)}
                      placeholder="20.00"
                    />
                    <p className="text-xs text-muted-foreground">Optional — leave blank to match any amount.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="credit-tolerance">Match tolerance ($)</Label>
                    <Input
                      id="credit-tolerance"
                      inputMode="decimal"
                      value={tolerance}
                      onChange={(e) => setTolerance(e.target.value)}
                      placeholder="0.01"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="credit-remind">Remind me N days before expiry</Label>
                  <Input
                    id="credit-remind"
                    inputMode="numeric"
                    value={remindDays}
                    onChange={(e) => setRemindDays(e.target.value)}
                    placeholder="7"
                  />
                </div>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving…' : credit ? 'Save' : 'Add credit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
