import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ReportTreeTable } from './ReportTreeTable'
import { TransactionDialogContext } from '@/components/finance/transactionDialog'
import { makeTxn } from '@/test/factories'

const txn = makeTxn({ id: 't-9', merchant_name: 'Blue Bottle', amount: 6 })
const root = {
  id: 'spend',
  label: 'Expenses',
  total: 6,
  txns: [],
  children: [{ id: 'c-d', label: 'Dining & Drinks', total: 6, children: [], txns: [txn] }],
}

describe('ReportTreeTable transaction rows', () => {
  it('open the transaction dialog when clicked, like the Transactions tab', () => {
    const open = vi.fn()
    render(
      <TransactionDialogContext.Provider value={open}>
        <ReportTreeTable root={root} title="Expenses" accountsById={new Map()} flow="spend" />
      </TransactionDialogContext.Provider>,
    )
    fireEvent.click(screen.getByRole('row', { name: 'Open Blue Bottle' }))
    expect(open).toHaveBeenCalledWith(txn)
  })

  it('are plain rows without a dialog host', () => {
    render(<ReportTreeTable root={root} title="Expenses" accountsById={new Map()} flow="spend" />)
    expect(screen.queryByRole('row', { name: 'Open Blue Bottle' })).toBeNull()
  })
})
