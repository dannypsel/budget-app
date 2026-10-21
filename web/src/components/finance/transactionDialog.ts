// Open a transaction's detail dialog (category, exclude toggle, notes, tags,
// splits…) from anywhere under <TransactionDialogProvider> — Reports rows use
// it so they're clickable like Simplifi's. Null outside a provider.

import { createContext, useContext } from 'react'
import type { Transaction } from '@/types/domain'

export const TransactionDialogContext = createContext<((t: Transaction) => void) | null>(null)

export function useOpenTransaction(): ((t: Transaction) => void) | null {
  return useContext(TransactionDialogContext)
}
