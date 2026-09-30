// Rewards — merged Points + Card Credits. Annual fees, 5/24, and bonus
// deadlines stay in Churning; this page is the hero for credits that still
// need spending, plus the minimal manual points balances.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff, Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import ConfirmDialog from '@/components/ConfirmDialog'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  creditIsUsed,
  creditRemaining,
  creditUnusedPillText,
} from '@/lib/churning'
import { creditShortLabel, filterCredits, sortCreditsByDaysRemaining, type CreditListFilter } from '@/lib/rewards'
import { formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import * as disc from '@/data/discretionary'
import * as churnApi from '@/data/churning'
import { sbKeys } from '@/data/hooks'
import type { RewardPoints, RewardPointsInsert, UUID } from '@/types/domain'

const iconBtn =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary motion-reduce:transition-none'

const FILTER_LABELS: { id: CreditListFilter; label: string }[] = [
  { id: 'needs', label: 'Needs spending' },
  { id: 'all', label: 'All' },
  { id: 'used', label: 'Used' },
]

export default function RewardsPage() {
  const queryClient = useQueryClient()
  const { data: points = [], isLoading: pointsLoading } = useQuery({
    queryKey: ['sb', 'rewards', 'points'],
    queryFn: disc.fetchRewardPoints,
  })
  const { data: credits = [], isLoading: creditsLoading } = useQuery({
    queryKey: sbKeys.allChurnCredits,
    queryFn: () => churnApi.fetchAllChurnCredits(),
  })

  const [filter, setFilter] = useState<CreditListFilter>('needs')
  const [pointDialog, setPointDialog] = useState<{ point: RewardPoints | null } | null>(null)
  const [spendDialog, setSpendDialog] = useState<RewardPoints | null>(null)
  const [hideConfirm, setHideConfirm] = useState<{ id: UUID; name: string } | null>(null)

  const visibleCredits = useMemo(
    () => sortCreditsByDaysRemaining(filterCredits(credits, filter)),
    [credits, filter],
  )
  const unusedTotal = useMemo(
    () => filterCredits(credits, 'needs').reduce((sum, c) => sum + creditRemaining(c), 0),
    [credits],
  )
  const needsCount = useMemo(() => filterCredits(credits, 'needs').length, [credits])

  const hideCredit = useMutation({
    mutationFn: (id: UUID) => churnApi.updateChurnCredit(id, { is_hidden: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sbKeys.allChurnCredits })
      void queryClient.invalidateQueries({ queryKey: ['sb', 'churning', 'credits'] })
      toast.success('Credit hidden — restore it in Settings → Card credits')
      setHideConfirm(null)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not hide credit'),
  })

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Rewards</h1>
        <Button onClick={() => setPointDialog({ point: null })}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          Add points
        </Button>
      </div>

      {/* Card credits — the hero section */}
      <section aria-label="Card credits">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">Card credits</h2>
          <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Credit filter">
            {FILTER_LABELS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  filter === id
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
                {id === 'needs' && needsCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-xs font-semibold text-primary">
                    {needsCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {filter === 'needs' && unusedTotal > 0 && (
          <Card className="mb-3 border-primary/30 bg-primary/5">
            <CardContent className="flex items-center justify-between py-3">
              <p className="text-sm text-foreground">
                <span className="font-semibold">{formatCurrency(unusedTotal)}</span> in unused
                credits still needs spending
              </p>
            </CardContent>
          </Card>
        )}

        {creditsLoading ? (
          <p className="text-sm text-muted-foreground">Loading credits…</p>
        ) : visibleCredits.length === 0 ? (
          <div className="card-surface p-8 text-center text-sm text-muted-foreground">
            {filter === 'needs'
              ? 'Nothing needs spending right now — every credit is used or hidden.'
              : filter === 'used'
                ? 'No used credits yet.'
                : 'No credits tracked. Add credits from the Churning tab.'}
          </div>
        ) : (
          <div className="card-surface overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Program</TableHead>
                  <TableHead className="text-xs">Credit</TableHead>
                  <TableHead className="text-xs">Card</TableHead>
                  <TableHead className="text-xs text-right">Unused</TableHead>
                  <TableHead className="text-xs">Resets</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleCredits.map((c) => {
                  const remaining = creditRemaining(c)
                  const used = creditIsUsed(c)
                  const partial = !used && Number(c.used_amount) > 0
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap text-sm font-medium text-foreground">
                        {creditShortLabel(c)}
                      </TableCell>
                      <TableCell className="text-sm">{c.credit_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {c.churn_cards?.card_name ?? '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm font-medium">
                        {formatCurrency(remaining)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {c.reset_date ? formatShortDate(c.reset_date) : '—'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold',
                            used
                              ? 'bg-muted text-muted-foreground'
                              : 'bg-money-income/15 text-money-income',
                          )}
                        >
                          {used ? 'Used' : partial ? 'Partially used' : creditUnusedPillText(c)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          title="Hide credit"
                          aria-label={`Hide ${c.credit_name} credit`}
                          onClick={() => setHideConfirm({ id: c.id, name: c.credit_name })}
                          className={cn(iconBtn, 'hover:bg-destructive/10 hover:text-destructive')}
                        >
                          <EyeOff aria-hidden className="h-4 w-4" />
                        </button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Hidden credits are excluded from every list, total, and count — restore them in
          Settings → Card credits.
        </p>
      </section>

      {/* Points — minimal manual balances */}
      <section aria-label="Points">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Points</h2>
        <div className="card-surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Program</TableHead>
                <TableHead className="text-xs">Holder</TableHead>
                <TableHead className="text-xs text-right">Balance</TableHead>
                <TableHead className="text-xs">Last updated</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pointsLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-muted-foreground">
                    Loading points…
                  </TableCell>
                </TableRow>
              ) : points.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No points balances yet.
                  </TableCell>
                </TableRow>
              ) : (
                points.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-sm font-medium text-foreground">{p.program}</TableCell>
                    <TableCell className="text-sm">{p.holder}</TableCell>
                    <TableCell className="whitespace-nowrap text-right text-sm font-medium">
                      {Math.round(Number(p.balance)).toLocaleString()} pts
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {p.last_updated ? formatShortDate(p.last_updated) : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setSpendDialog(p)}
                        >
                          Log spend
                        </Button>
                        <button
                          type="button"
                          title="Edit"
                          aria-label={`Edit ${p.program} balance`}
                          onClick={() => setPointDialog({ point: p })}
                          className={iconBtn}
                        >
                          <Pencil aria-hidden className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {pointDialog && (
        <PointDialog
          point={pointDialog.point}
          onClose={() => setPointDialog(null)}
        />
      )}
      {spendDialog && (
        <LogSpendDialog point={spendDialog} onClose={() => setSpendDialog(null)} />
      )}
      <ConfirmDialog
        open={!!hideConfirm}
        title="Hide this credit?"
        message={`“${hideConfirm?.name ?? ''}” will be excluded from every credit list, total, and count. You can restore it in Settings → Card credits.`}
        confirmLabel="Hide credit"
        onConfirm={() => {
          if (hideConfirm) hideCredit.mutate(hideConfirm.id)
        }}
        onCancel={() => setHideConfirm(null)}
      />
    </div>
  )
}

// ─── Points dialogs ─────────────────────────────────────────────────────────

function PointDialog({ point, onClose }: { point: RewardPoints | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [program, setProgram] = useState(point?.program ?? '')
  const [holder, setHolder] = useState(point?.holder ?? '')
  const [balance, setBalance] = useState(point ? String(Math.round(Number(point.balance))) : '')

  const save = useMutation({
    mutationFn: async (insert: RewardPointsInsert): Promise<void> => {
      if (point) {
        await disc.updateRewardPoint(point.id, { ...insert, last_updated: new Date().toISOString() })
        return
      }
      await disc.createRewardPoint(insert)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sb', 'rewards', 'points'] })
      toast.success(point ? 'Balance updated' : 'Points added')
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save points'),
  })

  const bal = Number.parseInt(balance, 10)
  const valid = program.trim().length > 0 && holder.trim().length > 0 && Number.isInteger(bal) && bal >= 0

  return (
    <Dialog open onOpenChange={(o) => !save.isPending && !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{point ? 'Edit points' : 'Add points'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="pts-program">Program</Label>
            <Input id="pts-program" value={program} onChange={(e) => setProgram(e.target.value)} autoFocus placeholder="e.g. Amex" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pts-holder">Holder</Label>
            <Input id="pts-holder" value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="e.g. Daniel" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pts-balance">Balance (points)</Label>
            <Input id="pts-balance" inputMode="numeric" value={balance} onChange={(e) => setBalance(e.target.value.replace(/[^0-9]/g, ''))} placeholder="50000" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate({ program: program.trim(), holder: holder.trim(), balance: bal })}
          >
            {save.isPending ? 'Saving…' : point ? 'Save changes' : 'Add points'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LogSpendDialog({ point, onClose }: { point: RewardPoints; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [spend, setSpend] = useState('')

  const save = useMutation({
    mutationFn: () => disc.logRewardPointsSpend(point.id, Number(point.balance), Number.parseInt(spend, 10) || 0),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sb', 'rewards', 'points'] })
      toast.success('Spend logged')
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not log spend'),
  })

  const amount = Number.parseInt(spend, 10)
  const valid = Number.isInteger(amount) && amount > 0

  return (
    <Dialog open onOpenChange={(o) => !save.isPending && !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Log spend</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Subtract from your {point.program} ({point.holder}) balance of{' '}
          <span className="font-medium text-foreground">
            {Math.round(Number(point.balance)).toLocaleString()} pts
          </span>
          .
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="pts-spend">Spent (points)</Label>
          <Input
            id="pts-spend"
            inputMode="numeric"
            autoFocus
            value={spend}
            onChange={(e) => setSpend(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="12000"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Log spend'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
