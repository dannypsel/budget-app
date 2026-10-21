import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { TransactionDetails } from './TransactionDetails'
import { makeCategory, makeTxn } from '@/test/factories'
import { splitRemainder } from '@/data/txnExtras'

const setTxnFlag = vi.fn().mockResolvedValue(undefined)
const replaceSplits = vi.fn().mockResolvedValue(undefined)
const addRule = vi.fn()

vi.mock('@/data/txnExtras', async (orig) => ({
  ...(await orig<typeof import('@/data/txnExtras')>()),
  setTxnFlag: (...a: unknown[]) => setTxnFlag(...a),
  replaceSplits: (...a: unknown[]) => replaceSplits(...a),
  fetchAttachments: vi.fn().mockResolvedValue([]),
  setTxnNotes: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/data/hooks', () => ({
  useCategories: () => ({ data: [makeCategory({ id: 'cat-g', name: 'Groceries' }), makeCategory({ id: 'cat-h', name: 'Household' })] }),
  useAddRule: () => ({ mutate: addRule, isPending: false }),
  useRecurringSeries: () => ({ data: [] }),
  useSetRecurringStatus: () => ({ mutate: vi.fn() }),
}))

function renderDetails(txn = makeTxn({ id: 't1', amount: 100, merchant_name: 'Target', category_id: 'cat-g', categories: makeCategory({ id: 'cat-g', name: 'Groceries' }), original_description: 'TARGET T-1234 SEATTLE WA' })) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TransactionDetails txn={txn} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('<TransactionDetails>', () => {
  it('shows the statement name and saves a color flag', async () => {
    renderDetails()
    expect(screen.getByText('TARGET T-1234 SEATTLE WA')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('green flag'))
    await waitFor(() => expect(setTxnFlag).toHaveBeenCalledWith('t1', 'GREEN', null))
  })

  it('blocks saving a split until it balances, then saves', async () => {
    renderDetails()
    await userEvent.click(screen.getByText('Split transaction'))
    const save = screen.getByText('Save split')
    expect(save).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Split 2 category'), 'cat-h')
    await userEvent.clear(screen.getByLabelText('Split 1 amount'))
    await userEvent.type(screen.getByLabelText('Split 1 amount'), '60')
    await userEvent.clear(screen.getByLabelText('Split 2 amount'))
    await userEvent.type(screen.getByLabelText('Split 2 amount'), '40')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    await waitFor(() =>
      expect(replaceSplits).toHaveBeenCalledWith('t1', 100, [
        { category_id: 'cat-g', amount: 60 },
        { category_id: 'cat-h', amount: 40 },
      ]),
    )
  })

  it('creates a payee rule from the transaction', async () => {
    renderDetails()
    await userEvent.click(screen.getByText('Create a rule from this transaction'))
    await userEvent.click(screen.getByText('Create rule'))
    expect(addRule).toHaveBeenCalledWith(
      { keyword: 'target', categoryId: 'cat-g', direction: 'out' },
      expect.anything(),
    )
  })
})

describe('splitRemainder', () => {
  it('rounds to cents', () => {
    expect(splitRemainder(10, [{ amount: 3.33 }, { amount: 3.33 }, { amount: 3.34 }])).toBe(0)
    expect(splitRemainder(10, [{ amount: 4 }])).toBe(6)
  })
})
