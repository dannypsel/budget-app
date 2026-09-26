import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ManageRulesDialog } from './ManageRulesDialog'
import { makeCategory, makeRule } from '@/test/factories'

const addMutate = vi.fn()
const deleteMutate = vi.fn()
// Auto-categorize mutate(undefined, { onSuccess }) — resolve a canned count so the toast fires.
let autoCount = 3
const autoMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: (n: number) => void }) =>
  opts?.onSuccess?.(autoCount),
)
const toastSuccess = vi.fn()

vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }))

vi.mock('@/data/hooks', () => ({
  useRules: () => ({
    data: [makeRule({ id: 'rule-g', keyword: 'Whole Foods', category_id: 'cat-g' })],
  }),
  useCategories: () => ({
    data: [
      makeCategory({ id: 'cat-g', name: 'Groceries', icon: 'cart.fill' }),
      makeCategory({ id: 'cat-d', name: 'Dining', icon: 'fork.knife' }),
    ],
  }),
  useAddRule: () => ({ mutate: addMutate }),
  useDeleteRule: () => ({ mutate: deleteMutate }),
  useAutoCategorizeUncategorized: () => ({ mutate: autoMutate, isPending: false }),
}))

describe('<ManageRulesDialog>', () => {
  beforeEach(() => {
    addMutate.mockClear()
    deleteMutate.mockClear()
    autoMutate.mockClear()
    toastSuccess.mockClear()
    autoCount = 3
  })

  it('titles the dialog "Auto Classify"', () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    expect(screen.getByText('Auto Classify')).toBeInTheDocument()
  })

  it('lists existing rules human-readably (describeRule)', () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    // A plain legacy rule renders as `"<keyword>" → <Category>`.
    expect(screen.getByText('"Whole Foods" → Groceries')).toBeInTheDocument()
    expect(screen.getByLabelText('Delete rule for Whole Foods')).toBeInTheDocument()
  })

  it('adds a plain keyword→category rule (conditions default to any/none)', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText('Rule keyword'), 'Uber')
    await userEvent.selectOptions(screen.getByLabelText('Rule category'), 'cat-d')
    await userEvent.click(screen.getByText('Add rule'))
    expect(addMutate).toHaveBeenCalledWith(
      {
        keyword: 'Uber',
        categoryId: 'cat-d',
        direction: null,
        minAmount: null,
        maxAmount: null,
        setReimbursement: false,
      },
      expect.anything(),
    )
  })

  it('builds a conditional rule: direction + amount + reimbursement', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText('Rule keyword'), 'Ved Rao')
    await userEvent.selectOptions(screen.getByLabelText('Money direction'), 'in')
    await userEvent.selectOptions(screen.getByLabelText('Amount condition'), 'over')
    await userEvent.type(screen.getByLabelText('Minimum amount'), '1500')
    await userEvent.selectOptions(screen.getByLabelText('Rule category'), 'cat-g')
    await userEvent.click(screen.getByLabelText('Mark as reimbursement'))
    await userEvent.click(screen.getByText('Add rule'))
    expect(addMutate).toHaveBeenCalledWith(
      {
        keyword: 'Ved Rao',
        categoryId: 'cat-g',
        direction: 'in',
        minAmount: 1500,
        maxAmount: null,
        setReimbursement: true,
      },
      expect.anything(),
    )
  })

  it('does not add without a keyword and at least one action', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText('Rule keyword'), 'Uber')
    // no category and reimbursement unchecked → Add stays disabled
    await userEvent.click(screen.getByText('Add rule'))
    expect(addMutate).not.toHaveBeenCalled()
  })

  it('deletes a rule', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByLabelText('Delete rule for Whole Foods'))
    expect(deleteMutate).toHaveBeenCalledWith('rule-g')
  })

  it('runs auto-categorize and reports the count', async () => {
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('Auto-categorize uncategorized'))
    expect(autoMutate).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Categorized 3 transactions.')
  })

  it('auto-categorize reports the empty case gracefully', async () => {
    autoCount = 0
    render(<ManageRulesDialog open onOpenChange={() => {}} />)
    await userEvent.click(screen.getByText('Auto-categorize uncategorized'))
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Nothing to categorize'))
  })
})
