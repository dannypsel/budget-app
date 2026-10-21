// Create transaction — Simplifi-style "+ New" dialog: payee, amount with a
// spend/income toggle, date, account, category, and a Pending flag. Inserts a
// manual row (provenance `manual:` plaid id) through the data layer.

import { useState } from 'react'
import { hierarchical } from '@/lib/categoryTree'
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
import { useCreateManualTransaction } from '@/data/hooks'
import { toISODate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import type { Account, Category, UUID } from '@/types/domain'

const selectClass =
  'h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary'

export default function CreateTransactionDialog({
  open,
  onOpenChange,
  accounts,
  categories,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: Account[]
  categories: Category[]
}) {
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<'spend' | 'income'>('spend')
  const [date, setDate] = useState(() => toISODate(new Date()))
  const [accountId, setAccountId] = useState<UUID | ''>('')
  const [categoryId, setCategoryId] = useState<UUID | ''>('')
  const [pending, setPending] = useState(false)
  const create = useCreateManualTransaction()

  const effectiveAccountId = accountId || accounts[0]?.id || ''

  async function save() {
    const parsed = Number(amount)
    if (!payee.trim()) {
      toast.error('Enter a payee.')
      return
    }
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Enter a positive amount.')
      return
    }
    if (!effectiveAccountId) {
      toast.error('Pick an account.')
      return
    }
    try {
      await create.mutateAsync({
        accountId: effectiveAccountId,
        date,
        amount: kind === 'spend' ? parsed : -parsed,
        merchant: payee.trim(),
        categoryId: categoryId || null,
        pending,
      })
      toast.success('Transaction added')
      setPayee('')
      setAmount('')
      onOpenChange(false)
    } catch {
      toast.error('Could not add the transaction')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create transaction</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-txn-payee">Payee</Label>
            <Input
              id="new-txn-payee"
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-txn-amount">Amount ($)</Label>
              <Input
                id="new-txn-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <div className="inline-flex gap-1 rounded-lg border border-outline-variant/50 p-1">
                {(
                  [
                    { v: 'spend', label: 'Expense' },
                    { v: 'income', label: 'Income' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setKind(o.v)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm transition-colors',
                      kind === o.v
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-txn-date">Date</Label>
              <Input
                id="new-txn-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-txn-account">Account</Label>
              <select
                id="new-txn-account"
                value={effectiveAccountId}
                onChange={(e) => setAccountId(e.target.value as UUID)}
                className={selectClass}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-txn-category">Category</Label>
            <select
              id="new-txn-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value as UUID | '')}
              className={selectClass}
            >
              <option value="">Uncategorized</option>
              {hierarchical(categories).map(({ c, label }) => (
                <option key={c.id} value={c.id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={pending} onCheckedChange={setPending} />
            Pending (not yet cleared)
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
