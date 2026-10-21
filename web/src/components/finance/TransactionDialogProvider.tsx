// Hosts the transaction detail dialog (CategoryPickerDialog) for everything
// beneath it; see ./transactionDialog. Report rows can be split legs
// ("<txn id>:<split id>", lib/reports.expandSplits) — those open the parent.

import { useCallback, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { CategoryPickerDialog } from './CategoryPickerDialog'
import { TransactionDialogContext } from './transactionDialog'
import { useSetCategory } from '@/data/hooks'
import { fetchTransactionById } from '@/data/transactions'
import type { Transaction } from '@/types/domain'

export function TransactionDialogProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Transaction | null>(null)
  const setCategory = useSetCategory()

  const open = useCallback((t: Transaction) => {
    const parentId = t.id.split(':')[0]
    if (parentId === t.id) {
      setSelected(t)
      return
    }
    fetchTransactionById(parentId)
      .then((full) => full && setSelected(full))
      .catch(() => toast.error('Could not open the transaction'))
  }, [])

  return (
    <TransactionDialogContext.Provider value={open}>
      {children}
      <CategoryPickerDialog
        txn={selected}
        open={selected != null}
        onOpenChange={(o) => !o && setSelected(null)}
        onPick={(categoryId) => {
          if (selected)
            setCategory.mutate(
              { txn: selected, categoryId },
              { onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save') },
            )
          setSelected(null)
        }}
      />
    </TransactionDialogContext.Provider>
  )
}
