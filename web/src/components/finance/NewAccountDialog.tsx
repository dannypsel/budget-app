// New account dialog — first screen offers two big choices: "Add manual
// account" (3-field form → useCreateSeparateAccount) or "Connect bank with
// Plaid" (navigates to Settings, which spotlights the bank-setup wizard on
// ?setup=1 — the Plaid Link tab flow lives there and is not reimplemented here).

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Landmark, PencilLine } from 'lucide-react'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateSeparateAccount } from '@/data/hooks'
import { cn } from '@/lib/utils'

const MANUAL_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit', label: 'Credit / debt' },
]

type Screen = 'choice' | 'manual'

export function NewAccountDialog({
  open,
  onOpenChange,
  plaidCapReached = false,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  plaidCapReached?: boolean
}) {
  const navigate = useNavigate()
  const create = useCreateSeparateAccount()
  const [screen, setScreen] = useState<Screen>('choice')
  const [name, setName] = useState('')
  const [type, setType] = useState('checking')
  const [startingBalance, setStartingBalance] = useState('')

  function reset() {
    setScreen('choice')
    setName('')
    setType('checking')
    setStartingBalance('')
  }

  const trimmedName = name.trim()

  async function save() {
    if (!trimmedName) return
    const start = startingBalance.trim() === '' ? null : Number(startingBalance)
    if (start != null && !Number.isFinite(start)) {
      toast.error('Starting balance must be a number.')
      return
    }
    try {
      await create.mutateAsync({
        name: trimmedName,
        type,
        startingBalance: start,
        recurring: null,
      })
      toast.success('Account created.')
      reset()
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create account.')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto rounded-xl border-0 bg-card shadow-card-hover">
        {screen === 'choice' ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-xl font-medium leading-7 text-foreground">
                New account
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <button
                type="button"
                onClick={() => setScreen('manual')}
                className="flex items-center gap-4 rounded-xl border border-border bg-surface-container-high p-4 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <PencilLine className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">
                    Add manual account
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    For cards not yet in Plaid
                  </span>
                </span>
              </button>
              <button
                type="button"
                disabled={plaidCapReached}
                onClick={() => {
                  onOpenChange(false)
                  navigate('/settings?setup=1')
                }}
                className={cn(
                  'flex items-center gap-4 rounded-xl border border-border bg-surface-container-high p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  plaidCapReached
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-accent/60',
                )}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Landmark className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">
                    Connect bank with Plaid
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {plaidCapReached
                      ? 'Bank connection limit reached'
                      : 'Sync checking, savings, and cards automatically'}
                  </span>
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() => setScreen('choice')}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                </button>
                <DialogTitle className="text-xl font-medium leading-7 text-foreground">
                  Add manual account
                </DialogTitle>
              </div>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="na-name">Name</Label>
                <Input
                  id="na-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Amex Gold"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="na-type">Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger id="na-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MANUAL_TYPE_OPTIONS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="na-start">Starting balance</Label>
                <Input
                  id="na-start"
                  inputMode="decimal"
                  value={startingBalance}
                  onChange={(e) => setStartingBalance(e.target.value)}
                  placeholder="e.g. 1200 (optional)"
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={create.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="pill"
                onClick={save}
                disabled={!trimmedName || create.isPending}
              >
                {create.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
