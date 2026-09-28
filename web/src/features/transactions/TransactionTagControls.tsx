// Per-row Need/Want + Fixed/Variable tag overrides. The selects show the
// transaction's current tag (blank = not yet classified); choosing a value
// updates the transaction row and remembers it for the merchant, so future
// transactions from the same merchant inherit the override.

import { toast } from 'sonner'
import { useSetTxnTags } from '@/data/hooks'
import { displayName } from '@/types/domain'
import type { TxnTagPatch } from '@/data/txnTags'
import type { Transaction } from '@/types/domain'

const SELECT_CLASS =
  'h-8 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary'

export function TransactionTagControls({ txn }: { txn: Transaction }) {
  const save = useSetTxnTags()

  async function onChange(patch: TxnTagPatch) {
    try {
      await save.mutateAsync({ txn, patch })
    } catch {
      toast.error('Could not save tag')
    }
  }

  const label = displayName(txn)
  return (
    <div className="flex gap-2 px-4 pb-3" onClick={(e) => e.stopPropagation()}>
      <select
        aria-label={`Need or want for ${label}`}
        value={txn.need_want ?? ''}
        onChange={(e) =>
          void onChange({ need_want: e.target.value === '' ? null : (e.target.value as 'need' | 'want') })
        }
        className={SELECT_CLASS}
      >
        <option value="">Need/Want</option>
        <option value="need">Need</option>
        <option value="want">Want</option>
      </select>
      <select
        aria-label={`Fixed or variable for ${label}`}
        value={txn.spend_pattern ?? ''}
        onChange={(e) =>
          void onChange({
            spend_pattern: e.target.value === '' ? null : (e.target.value as 'fixed' | 'variable'),
          })
        }
        className={SELECT_CLASS}
      >
        <option value="">Fixed/Variable</option>
        <option value="fixed">Fixed</option>
        <option value="variable">Variable</option>
      </select>
    </div>
  )
}
