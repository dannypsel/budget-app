// Discretionary — Daniel-vs-Sara game/bet balances plus the Challenges section.
// These numbers are deliberately isolated: they live in their own tables and are
// NEVER mixed into household totals or the spending plan.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Plus, Target, Trophy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  SortableTableHead,
} from '@/components/sortable-table-head'
import * as disc from '@/data/discretionary'
import {
  challengeIsComplete,
  challengeRangeDates,
  computeDiscretionaryStats,
  adjustmentInsert,
  gameResultInsert,
  purchaseInsert,
  requiredCheckins,
  transferInsert,
} from '@/lib/discretionary'
import { formatCurrency } from '@/lib/money'
import { formatShortDate } from '@/lib/dates'
import { cycleSort, sortBySelector, type ColumnSortState } from '@/lib/tableSort'
import type {
  Challenge,
  ChallengeInsert,
  ChallengeStatus,
  DiscretionaryEntryType,
  DiscretionaryLedgerInsert,
  DiscretionaryPerson,
} from '@/types/domain'
import { cn } from '@/lib/utils'

const ORIGINAL_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1XxbrDBmQFnFT22MxrIeO2vMGJ1fYd6vW8wSEBo_br-Y/edit'

const ENTRY_TYPE_LABEL: Record<DiscretionaryEntryType, string> = {
  game: 'Game',
  purchase: 'Purchase',
  challenge: 'Challenge',
  bet: 'Bet',
  adjustment: 'Adjustment',
}

function signed(amount: number): string {
  const n = Number(amount)
  if (n === 0) return '—'
  return `${n > 0 ? '+' : '−'}${formatCurrency(Math.abs(n)).replace('-', '')}`
}

function signedClass(amount: number): string {
  const n = Number(amount)
  if (n > 0) return 'text-money-income font-medium'
  if (n < 0) return 'text-money-expense font-medium'
  return 'text-muted-foreground'
}

const todayStr = () => new Date().toISOString().slice(0, 10)

function PersonBalanceCard({
  person,
  balance,
  earned,
  spent,
}: {
  person: DiscretionaryPerson
  balance: number
  earned: number
  spent: number
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium capitalize text-muted-foreground">
          {person}&rsquo;s balance
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={cn('text-3xl font-semibold tracking-tight', signedClass(balance))}>
          {formatCurrency(balance)}
        </p>
        <div className="mt-2 flex gap-6 text-sm text-muted-foreground">
          <span>
            Earned <span className="font-medium text-foreground">{formatCurrency(earned)}</span>
          </span>
          <span>
            Spent <span className="font-medium text-foreground">{formatCurrency(spent)}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

export default function DiscretionaryPage() {
  const queryClient = useQueryClient()
  const {
    data: ledger = [],
    isLoading: ledgerLoading,
  } = useQuery({ queryKey: ['sb', 'discretionary', 'ledger'], queryFn: disc.fetchDiscretionaryLedger })
  const {
    data: gameTypes = [],
    isLoading: typesLoading,
  } = useQuery({ queryKey: ['sb', 'discretionary', 'gameTypes'], queryFn: disc.fetchGameTypes })
  const {
    data: challenges = [],
    isLoading: challengesLoading,
  } = useQuery({ queryKey: ['sb', 'discretionary', 'challenges'], queryFn: disc.fetchChallenges })

  const [entryOpen, setEntryOpen] = useState(false)
  const [challengeOpen, setChallengeOpen] = useState(false)
  const [sort, setSort] = useState<ColumnSortState | null>(null)

  // First load with no game types → seed the starters (idempotent upsert).
  const seededRef = useRef(false)
  useEffect(() => {
    if (typesLoading || gameTypes.length > 0 || seededRef.current) return
    seededRef.current = true
    void disc
      .seedGameTypes(['Dominion', 'Ping Pong'])
      .then(() => queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'gameTypes'] }))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not seed game types'))
  }, [typesLoading, gameTypes.length, queryClient])

  const stats = useMemo(() => computeDiscretionaryStats(ledger), [ledger])
  const typeNameById = useMemo(
    () => new Map<string, string>(gameTypes.map((t) => [t.id, t.name])),
    [gameTypes],
  )

  const sortedLedger = useMemo(
    () =>
      sortBySelector(ledger, sort, {
        date: (e) => e.occurred_on,
        type: (e) => e.entry_type,
        game: (e) => typeNameById.get(e.game_type_id ?? '') ?? '',
        winner: (e) => e.winner ?? '',
        payout: (e) => Number(e.payout ?? 0),
        daniel: (e) => Number(e.daniel_amount),
        sara: (e) => Number(e.sara_amount),
        note: (e) => e.note ?? '',
      }),
    [ledger, sort, typeNameById],
  )

  return (
    <div className="flex flex-col gap-6 pt-4 md:pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Discretionary
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Daniel vs Sara game &amp; bet balances — kept separate from household money.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a href={ORIGINAL_SHEET_URL} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden />
              Original sheet
            </a>
          </Button>
          <Button onClick={() => setEntryOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Add entry
          </Button>
        </div>
      </div>

      {/* Balances */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PersonBalanceCard
          person="daniel"
          balance={stats.daniel.balance}
          earned={stats.daniel.earned}
          spent={stats.daniel.spent}
        />
        <PersonBalanceCard
          person="sara"
          balance={stats.sara.balance}
          earned={stats.sara.earned}
          spent={stats.sara.spent}
        />
      </div>

      {/* Game stats */}
      <section className="card-surface p-4" aria-label="Game stats">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {[
            ['Daniel wins', stats.danielWins],
            ['Sara wins', stats.saraWins],
            ['Ties', stats.ties],
            ['Total games', stats.totalGames],
            ['Days playing', stats.daysPlaying],
          ].map(([label, value]) => (
            <div key={label as string}>
              <p className="text-2xl font-semibold text-foreground">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Ledger */}
      <section aria-label="Ledger">
        <h2 className="mb-2 text-lg font-semibold text-foreground">Ledger</h2>
        <div className="card-surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Date" columnKey="date" sort={sort} onSort={(k) => setSort(cycleSort(sort, k))} />
                <SortableTableHead label="Type" columnKey="type" sort={sort} onSort={(k) => setSort(cycleSort(sort, k))} />
                <SortableTableHead label="Game" columnKey="game" sort={sort} onSort={(k) => setSort(cycleSort(sort, k))} />
                <SortableTableHead label="Winner" columnKey="winner" sort={sort} onSort={(k) => setSort(cycleSort(sort, k))} />
                <SortableTableHead label="Payout" columnKey="payout" sort={sort} onSort={(k) => setSort(cycleSort(sort, k))} align="right" />
                <SortableTableHead label="Daniel" columnKey="daniel" sort={sort} onSort={(k) => setSort(cycleSort(sort, k))} align="right" />
                <SortableTableHead label="Sara" columnKey="sara" sort={sort} onSort={(k) => setSort(cycleSort(sort, k))} align="right" />
                <TableHead className="text-xs">Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledgerLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-sm text-muted-foreground">
                    Loading ledger…
                  </TableCell>
                </TableRow>
              ) : sortedLedger.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    No entries yet — add your first game result.
                  </TableCell>
                </TableRow>
              ) : (
                sortedLedger.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-sm">{formatShortDate(e.occurred_on)}</TableCell>
                    <TableCell className="text-sm">{ENTRY_TYPE_LABEL[e.entry_type]}</TableCell>
                    <TableCell className="text-sm">{e.entry_type === 'game' ? (typeNameById.get(e.game_type_id ?? '') ?? '—') : '—'}</TableCell>
                    <TableCell className="text-sm capitalize">{e.winner ?? '—'}</TableCell>
                    <TableCell className="text-right text-sm">
                      {e.payout != null && Number(e.payout) !== 0 ? formatCurrency(Number(e.payout)) : '—'}
                    </TableCell>
                    <TableCell className={cn('whitespace-nowrap text-right text-sm', signedClass(Number(e.daniel_amount)))}>
                      {signed(Number(e.daniel_amount))}
                    </TableCell>
                    <TableCell className={cn('whitespace-nowrap text-right text-sm', signedClass(Number(e.sara_amount)))}>
                      {signed(Number(e.sara_amount))}
                    </TableCell>
                    <TableCell className="max-w-60 truncate text-sm text-muted-foreground">{e.note ?? ''}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* Challenges */}
      <ChallengesSection
        challenges={challenges}
        isLoading={challengesLoading}
        onAdd={() => setChallengeOpen(true)}
      />

      {/* key remounts each dialog when it opens, resetting its form state */}
      <AddEntryDialog
        key={entryOpen ? 'entry-open' : 'entry-closed'}
        open={entryOpen}
        onClose={() => setEntryOpen(false)}
        gameTypes={gameTypes.map((t) => ({ id: t.id, name: t.name }))}
      />
      <AddChallengeDialog
        key={challengeOpen ? 'challenge-open' : 'challenge-closed'}
        open={challengeOpen}
        onClose={() => setChallengeOpen(false)}
      />
    </div>
  )
}

// ─── Add-entry dialog ───────────────────────────────────────────────────────

function useSaveEntry(onClose: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (insert: DiscretionaryLedgerInsert) => disc.createLedgerEntry(insert),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'ledger'] })
      toast.success('Entry added')
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not add entry'),
  })
}

function num(v: string): number {
  return Number.parseFloat(v) || 0
}

function AddEntryDialog({
  open,
  onClose,
  gameTypes,
}: {
  open: boolean
  onClose: () => void
  gameTypes: { id: string; name: string }[]
}) {
  const save = useSaveEntry(onClose)
  const [date, setDate] = useState(todayStr())
  const [note, setNote] = useState('')
  // game
  const [gameTypeId, setGameTypeId] = useState('')
  const [winner, setWinner] = useState<'daniel' | 'sara' | 'tie'>('daniel')
  const [payout, setPayout] = useState('')
  // purchase / adjustment
  const [person, setPerson] = useState<DiscretionaryPerson>('daniel')
  const [amount, setAmount] = useState('')
  // transfer
  const [from, setFrom] = useState<DiscretionaryPerson>('daniel')

  function saveGame() {
    save.mutate(gameResultInsert({ occurredOn: date, gameTypeId: gameTypeId || null, winner, payout: num(payout), note }))
  }
  function savePurchase() {
    save.mutate(purchaseInsert({ occurredOn: date, person, amount: num(amount), note }))
  }
  function saveTransfer() {
    save.mutate(transferInsert({ occurredOn: date, from, amount: num(amount), note }))
  }
  function saveAdjustment() {
    save.mutate(adjustmentInsert({ occurredOn: date, person, amount: num(amount), note }))
  }

  const pending = save.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add ledger entry</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="entry-date">Date</Label>
          <Input id="entry-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Tabs defaultValue="game">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="game">Game</TabsTrigger>
            <TabsTrigger value="purchase">Purchase</TabsTrigger>
            <TabsTrigger value="bet">Bet</TabsTrigger>
            <TabsTrigger value="adjustment">Adjust</TabsTrigger>
          </TabsList>
          <TabsContent value="game" className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="entry-game-type">Game</Label>
              <Select value={gameTypeId} onValueChange={setGameTypeId}>
                <SelectTrigger id="entry-game-type">
                  <SelectValue placeholder="Choose a game" />
                </SelectTrigger>
                <SelectContent>
                  {gameTypes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {gameTypes.length === 0 && (
                <p className="text-xs text-muted-foreground">Add game types in Settings → Game types.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Winner</Label>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Winner">
                {(['daniel', 'sara', 'tie'] as const).map((w) => (
                  <Button
                    key={w}
                    type="button"
                    variant={winner === w ? 'default' : 'outline'}
                    onClick={() => setWinner(w)}
                    className="capitalize"
                  >
                    {w}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-payout">Payout ($)</Label>
              <Input id="entry-payout" inputMode="decimal" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="10.00" />
              <p className="text-xs text-muted-foreground">
                {winner === 'tie'
                  ? 'Tie: no money moves.'
                  : `${winner === 'daniel' ? 'Daniel' : 'Sara'} gains $${num(payout).toFixed(2)}, the other loses it.`}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-note">Note (optional)</Label>
              <Input id="entry-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" onClick={saveGame} disabled={pending || num(payout) <= 0}>
                {pending ? 'Saving…' : 'Save game result'}
              </Button>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="purchase" className="space-y-4 pt-2">
            <PersonSelect id="entry-purchase-person" value={person} onChange={setPerson} label="Who bought it" />
            <div className="space-y-1.5">
              <Label htmlFor="entry-purchase-amount">Amount ($)</Label>
              <Input id="entry-purchase-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" />
              <p className="text-xs text-muted-foreground">Subtracted from {person}&rsquo;s balance.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-purchase-note">Note (optional)</Label>
              <Input id="entry-purchase-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" onClick={savePurchase} disabled={pending || num(amount) <= 0}>
                {pending ? 'Saving…' : 'Save purchase'}
              </Button>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="bet" className="space-y-4 pt-2">
            <PersonSelect id="entry-bet-from" value={from} onChange={setFrom} label="Who lost the bet" />
            <div className="space-y-1.5">
              <Label htmlFor="entry-bet-amount">Amount ($)</Label>
              <Input id="entry-bet-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" />
              <p className="text-xs text-muted-foreground">
                Moves ${num(amount).toFixed(2)} from {from} to {from === 'daniel' ? 'sara' : 'daniel'}.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-bet-note">Note (optional)</Label>
              <Input id="entry-bet-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" onClick={saveTransfer} disabled={pending || num(amount) <= 0}>
                {pending ? 'Saving…' : 'Save bet transfer'}
              </Button>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="adjustment" className="space-y-4 pt-2">
            <PersonSelect id="entry-adj-person" value={person} onChange={setPerson} label="Person" />
            <div className="space-y-1.5">
              <Label htmlFor="entry-adj-amount">Amount ($, signed)</Label>
              <Input id="entry-adj-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5.00 or -5.00" />
              <p className="text-xs text-muted-foreground">Positive adds to the balance, negative subtracts.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-adj-note">Note (optional)</Label>
              <Input id="entry-adj-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" onClick={saveAdjustment} disabled={pending || num(amount) === 0}>
                {pending ? 'Saving…' : 'Save adjustment'}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function PersonSelect({
  id,
  value,
  onChange,
  label,
}: {
  id: string
  value: DiscretionaryPerson
  onChange: (p: DiscretionaryPerson) => void
  label: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as DiscretionaryPerson)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="daniel">Daniel</SelectItem>
          <SelectItem value="sara">Sara</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

// ─── Challenges section ─────────────────────────────────────────────────────

function ChallengesSection({
  challenges,
  isLoading,
  onAdd,
}: {
  challenges: Challenge[]
  isLoading: boolean
  onAdd: () => void
}) {
  const active = challenges.filter((c) => c.status === 'active')
  const past = challenges.filter((c) => c.status !== 'active')
  return (
    <section aria-label="Challenges">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Target className="h-5 w-5" aria-hidden />
          Challenges
        </h2>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          New challenge
        </Button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading challenges…</p>
      ) : challenges.length === 0 ? (
        <div className="card-surface p-8 text-center">
          <Trophy className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <h3 className="mt-3 text-lg font-semibold text-foreground">No challenges yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Create a habit challenge with a reward — check in each day and the reward
            pays out automatically when you finish.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {active.map((c) => (
            <ChallengeCard key={c.id} challenge={c} />
          ))}
          {past.map((c) => (
            <ChallengeCard key={c.id} challenge={c} />
          ))}
        </div>
      )}
    </section>
  )
}

const STATUS_LABEL: Record<ChallengeStatus, string> = {
  active: 'Active',
  completed: 'Completed',
  failed: 'Failed',
  overridden: 'Overridden',
}

function ChallengeCard({ challenge }: { challenge: Challenge }) {
  const queryClient = useQueryClient()
  const key = ['sb', 'discretionary', 'checkins', challenge.id]
  const { data: checkins = [] } = useQuery({ queryKey: key, queryFn: () => disc.fetchCheckins(challenge.id) })
  const [confirmFail, setConfirmFail] = useState(false)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const evaluatedRef = useRef(false)

  const required = requiredCheckins(challenge)
  const count = checkins.length
  const complete = challengeIsComplete(challenge, count)
  const fraction = required > 0 ? Math.min(1, count / required) : 1
  const dates = challengeRangeDates(challenge)
  const checked = useMemo(() => new Set(checkins.map((c) => c.checkin_date)), [checkins])

  // Backfill: a challenge whose check-ins already satisfy the rule pays out on load.
  useEffect(() => {
    if (evaluatedRef.current || challenge.status !== 'active' || !complete) return
    evaluatedRef.current = true
    void disc.evaluateChallengeCompletion(challenge, count).then((did) => {
      if (did) {
        void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'challenges'] })
        void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'ledger'] })
        toast.success(`Challenge completed — ${formatCurrency(challenge.reward)} paid to ${challenge.person}`)
      }
    })
  }, [complete, challenge, count, queryClient])

  const toggle = useMutation({
    mutationFn: (date: string) => disc.toggleCheckin(challenge.id, date),
    onSuccess: async () => {
      const updated = await disc.fetchCheckins(challenge.id)
      queryClient.setQueryData(key, updated)
      const did = await disc.evaluateChallengeCompletion(challenge, updated.length)
      if (did) {
        void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'challenges'] })
        void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'ledger'] })
        toast.success(`Challenge completed — ${formatCurrency(challenge.reward)} paid to ${challenge.person}`)
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not check in'),
  })

  const setStatus = useMutation({
    mutationFn: (status: ChallengeStatus) => disc.updateChallengeStatus(challenge.id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'challenges'] })
      setConfirmFail(false)
      setOverrideOpen(false)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not update challenge'),
  })

  const isActive = challenge.status === 'active'

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{challenge.title}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground capitalize">
              {challenge.person} · {challenge.frequency}
              {challenge.frequency === 'weekly' ? ` × ${challenge.times_per_week}/wk` : ''} ·{' '}
              {formatShortDate(challenge.start_date)} → {formatShortDate(challenge.end_date)}
            </p>
          </div>
          <span
            className={cn(
              'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
              challenge.status === 'active' && 'bg-primary/10 text-primary',
              challenge.status === 'completed' && 'bg-money-income/15 text-money-income',
              challenge.status === 'failed' && 'bg-destructive/10 text-destructive',
              challenge.status === 'overridden' && 'bg-muted text-muted-foreground',
            )}
          >
            {STATUS_LABEL[challenge.status]}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {count}/{required} check-ins
              {challenge.grace_days > 0 ? ` (${challenge.grace_days} grace)` : ''}
            </span>
            <span>Reward {formatCurrency(challenge.reward)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={count} aria-valuemax={required}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${fraction * 100}%` }} />
          </div>
        </div>

        {isActive && (
          <div className="flex flex-wrap gap-1.5" aria-label="Check-in days">
            {dates.map((d) => {
              const on = checked.has(d)
              return (
                <button
                  key={d}
                  type="button"
                  title={formatShortDate(d)}
                  aria-pressed={on}
                  aria-label={`${on ? 'Checked in' : 'Not checked in'} ${d}`}
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(d)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md text-xs font-medium transition-colors',
                    on
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-surface-variant',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  )}
                >
                  {new Date(`${d}T00:00:00`).getDate()}
                </button>
              )
            })}
          </div>
        )}

        {isActive && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmFail(true)}>
              Mark failed
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOverrideOpen(true)}>
              Override…
            </Button>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmFail}
        title="Mark challenge failed?"
        message={`“${challenge.title}” will be marked failed and no reward will be paid out.`}
        confirmLabel="Mark failed"
        onConfirm={() => setStatus.mutate('failed')}
        onCancel={() => setConfirmFail(false)}
      />

      <Dialog open={overrideOpen} onOpenChange={(o) => !setStatus.isPending && !o && setOverrideOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Override challenge</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Force-pay the {formatCurrency(challenge.reward)} reward to {challenge.person}, or
            cancel the challenge without paying.
          </p>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate('overridden')}
            >
              Cancel, no payout
            </Button>
            <Button
              type="button"
              disabled={setStatus.isPending}
              onClick={() => {
                void disc.completeChallenge(challenge).then(async () => {
                  await disc.updateChallengeStatus(challenge.id, 'overridden')
                  void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'challenges'] })
                  void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'ledger'] })
                  setOverrideOpen(false)
                  toast.success(`Reward paid to ${challenge.person}`)
                }).catch((e) => toast.error(e instanceof Error ? e.message : 'Could not pay out'))
              }}
            >
              Pay out reward
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ─── Add-challenge dialog ───────────────────────────────────────────────────

function AddChallengeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [person, setPerson] = useState<DiscretionaryPerson>('daniel')
  const [title, setTitle] = useState('')
  const [start, setStart] = useState(todayStr())
  const [end, setEnd] = useState(todayStr())
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily')
  const [timesPerWeek, setTimesPerWeek] = useState('3')
  const [reward, setReward] = useState('')
  const [grace, setGrace] = useState('0')

  const save = useMutation({
    mutationFn: (insert: ChallengeInsert) => disc.createChallenge(insert),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sb', 'discretionary', 'challenges'] })
      toast.success('Challenge created')
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not create challenge'),
  })

  const valid = title.trim().length > 0 && start <= end && num(reward) > 0

  function submit() {
    if (!valid) return
    save.mutate({
      person,
      title: title.trim(),
      start_date: start,
      end_date: end,
      frequency,
      times_per_week: frequency === 'weekly' ? Math.max(1, Math.round(num(timesPerWeek))) : null,
      reward: num(reward),
      grace_days: Math.max(0, Math.round(num(grace))),
      status: 'active',
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New challenge</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <PersonSelect id="ch-person" value={person} onChange={setPerson} label="Person" />
          <div className="space-y-1.5">
            <Label htmlFor="ch-title">Title</Label>
            <Input id="ch-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Read 20 minutes" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ch-start">Start date</Label>
              <Input id="ch-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-end">End date</Label>
              <Input id="ch-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ch-freq">Frequency</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as 'daily' | 'weekly')}>
                <SelectTrigger id="ch-freq">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {frequency === 'weekly' && (
              <div className="space-y-1.5">
                <Label htmlFor="ch-times">Times per week</Label>
                <Input id="ch-times" inputMode="numeric" value={timesPerWeek} onChange={(e) => setTimesPerWeek(e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ch-reward">Reward ($)</Label>
              <Input id="ch-reward" inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} placeholder="25.00" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-grace">Grace days</Label>
              <Input id="ch-grace" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!valid || save.isPending}>
            {save.isPending ? 'Creating…' : 'Create challenge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
