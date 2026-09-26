// Component tests for the credit auto-detection form (CreditDialog) and the
// credit status pill / mark-used flows (CreditRow). The data hooks are mocked;
// the pure pill math is covered in lib/churning.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { CreditDialog, CreditRow } from './ChurnCardDetailPage'
import type { ChurnCredit, Transaction } from '@/types/domain'
import { toISODate } from '@/lib/dates'

const mocks = vi.hoisted(() => ({
  createCreditMutate: vi.fn(),
  updateCreditMutate: vi.fn(),
  txn: null as Transaction | null,
}))

vi.mock('@/data/hooks', () => {
  const query =
    (data: unknown = []) =>
    () => ({ data, isLoading: false })
  const mutation = (mutateAsync: (...args: never[]) => unknown) => () => ({
    mutateAsync,
    isPending: false,
  })
  return {
    useAccounts: query([]),
    useBonusQualifyingSpend: () => ({ data: 0 }),
    useChurnBonuses: query([]),
    useChurnCard: () => ({ data: null, isLoading: false }),
    useChurnCredits: query([]),
    useCreateChurnBonus: mutation(vi.fn()),
    useCreateChurnCredit: mutation(mocks.createCreditMutate),
    useDeleteChurnBonus: mutation(vi.fn()),
    useDeleteChurnCard: mutation(vi.fn()),
    useDeleteChurnCredit: mutation(vi.fn()),
    useUpdateChurnBonus: mutation(vi.fn()),
    useUpdateChurnCredit: mutation(mocks.updateCreditMutate),
    useTransaction: (id: string | null) => ({
      data: id != null ? mocks.txn : null,
      isLoading: false,
    }),
    useAllChurnBonuses: query([]),
    useAllChurnCredits: query([]),
    useChurnCards: query([]),
    useCreateChurnCard: mutation(vi.fn()),
    useUpdateChurnCard: mutation(vi.fn()),
  }
})

const credit = (over: Partial<ChurnCredit> = {}): ChurnCredit => ({
  id: 'cr-1',
  card_id: 'card-1',
  credit_name: 'Dining',
  amount: 20,
  frequency: 'monthly',
  used_amount: 0,
  reset_date: null,
  notes: null,
  auto_detect: true,
  detect_merchant_keywords: ['grubhub'],
  detect_amount: 20,
  detect_tolerance: 0.01,
  used_at: null,
  detected_transaction_id: null,
  detection_source: null,
  detection_dismissed_transaction_ids: [],
  remind_days_before: 7,
  period_start_date: null,
  ...over,
})

const txn = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: 'txn-1',
    plaid_transaction_id: 'plaid-1',
    account_id: 'acct-1',
    date: '2026-09-12',
    authorized_date: null,
    effective_date: '2026-09-12',
    amount: -20, // statement credit (money in)
    merchant_name: 'Grubhub',
    description: 'GRUBHUB*ORDER',
    plaid_category: null,
    plaid_category_detail: null,
    category_id: null,
    notes: null,
    pending: false,
    exclude_from_totals: false,
    transfer_group_id: null,
    transfer_kind: null,
    transfer_opt_out: false,
    hidden: false,
    is_reimbursement: false,
    merchant_city: null,
    merchant_region: null,
    merchant_country: null,
    merchant_postal_code: null,
    merchant_store_number: null,
    merchant_lat: null,
    merchant_lon: null,
    iso_currency_code: null,
    ...over,
  }) as Transaction

function renderDialog(c: ChurnCredit | null = null) {
  return render(
    <MemoryRouter>
      <CreditDialog cardId="card-1" credit={c} onOpenChange={() => {}} />
    </MemoryRouter>,
  )
}

function renderRow(c: ChurnCredit) {
  return render(
    <MemoryRouter>
      <ul>
        <CreditRow credit={c} onEdit={() => {}} />
      </ul>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.txn = null
})

describe('<CreditDialog> auto-detection fields', () => {
  it('renders the auto-detect toggle (on by default), keyword/amount/tolerance/reminder fields, and the example help text', () => {
    renderDialog()
    expect(screen.getByRole('switch', { name: /Auto-detect usage/ })).toBeChecked()
    expect(screen.getByLabelText(/Merchant keywords/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Expected credit amount/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Match tolerance/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Remind me N days before expiry/)).toBeInTheDocument()
    expect(screen.getByText(/Amex Gold Business dining credit/)).toBeInTheDocument()
  })

  it('hides the detection fields when auto-detect is turned off', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('switch', { name: /Auto-detect usage/ }))
    expect(screen.queryByLabelText(/Merchant keywords/)).not.toBeInTheDocument()
  })

  it('blocks save when auto-detect is on but no keywords are given', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByLabelText(/Name/), 'Dining')
    await user.type(screen.getByLabelText(/Amount/), '20')
    await user.click(screen.getByRole('button', { name: 'Add credit' }))
    expect(mocks.createCreditMutate).not.toHaveBeenCalled()
  })

  it('saves with parsed keywords, expected amount, tolerance, and reminder days', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByLabelText(/Name/), 'Dining')
    await user.type(screen.getByLabelText(/Amount/), '20')
    await user.type(screen.getByLabelText(/Merchant keywords/), 'grubhub, doordash')
    await user.type(screen.getByLabelText(/Expected credit amount/), '20.00')
    await user.click(screen.getByRole('button', { name: 'Add credit' }))
    expect(mocks.createCreditMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        credit_name: 'Dining',
        amount: 20,
        auto_detect: true,
        detect_merchant_keywords: ['grubhub', 'doordash'],
        detect_amount: 20,
        detect_tolerance: 0.01,
        remind_days_before: 7,
      }),
    )
  })

  it('allows save without keywords when auto-detect is off', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByLabelText(/Name/), 'Dining')
    await user.type(screen.getByLabelText(/Amount/), '20')
    await user.click(screen.getByRole('switch', { name: /Auto-detect usage/ }))
    await user.click(screen.getByRole('button', { name: 'Add credit' }))
    expect(mocks.createCreditMutate).toHaveBeenCalledWith(
      expect.objectContaining({ auto_detect: false, detect_merchant_keywords: [] }),
    )
  })

  it('prefills existing detection config when editing', () => {
    renderDialog(
      credit({ detect_merchant_keywords: ['delta'], detect_amount: 200, remind_days_before: 14 }),
    )
    expect(screen.getByLabelText(/Merchant keywords/)).toHaveValue('delta')
    expect(screen.getByLabelText(/Expected credit amount/)).toHaveValue('200')
    expect(screen.getByLabelText(/Remind me N days before expiry/)).toHaveValue('14')
  })
})

describe('<CreditRow> status pill', () => {
  it('shows "Used · auto" with the matched-transaction subtext and a View transaction link', () => {
    mocks.txn = txn()
    renderRow(
      credit({
        detection_source: 'auto',
        detected_transaction_id: 'txn-1',
        used_amount: 20,
        used_at: '2026-09-12T10:00:00Z',
      }),
    )
    expect(screen.getByText('Used · auto')).toBeInTheDocument()
    expect(screen.getByText(/Grubhub · \$20\.00 · Sep 12/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'View transaction' })
    expect(link.getAttribute('href')).toBe('/transactions?q=Grubhub')
  })

  it('shows "Used · manual" for hand-marked credits', () => {
    renderRow(credit({ detection_source: 'manual', used_amount: 20 }))
    expect(screen.getByText('Used · manual')).toBeInTheDocument()
    expect(screen.queryByText('View transaction')).not.toBeInTheDocument()
  })

  it('shows unused pills with days-left edge states', () => {
    const today = new Date()
    const iso = (offsetDays: number) =>
      toISODate(new Date(today.getTime() + offsetDays * 86_400_000))
    const { unmount } = renderRow(credit({ reset_date: iso(0) }))
    expect(screen.getByText('Unused · resets today')).toBeInTheDocument()
    unmount()
    renderRow(credit({ reset_date: iso(-2) }))
    expect(screen.getByText('Unused · overdue')).toBeInTheDocument()
  })

  it('shows the auto-detect config summary in muted text', () => {
    const { container } = renderRow(credit())
    const summary = screen.getByText(/Auto-detect:/)
    expect(summary.closest('p')?.textContent).toContain('Auto-detect: grubhub · ~$20.00')
    expect(container.textContent).not.toContain('Auto-detect off')
  })

  it('shows "Auto-detect off" when detection is disabled', () => {
    renderRow(credit({ auto_detect: false, detect_merchant_keywords: [] }))
    expect(screen.getByText('Auto-detect off')).toBeInTheDocument()
  })

  it('"Mark used" marks the credit manual with used_at', async () => {
    const user = userEvent.setup()
    renderRow(credit())
    await user.click(screen.getByRole('button', { name: 'Mark used' }))
    expect(mocks.updateCreditMutate).toHaveBeenCalledWith({
      id: 'cr-1',
      patch: {
        used_amount: 20,
        detection_source: 'manual',
        used_at: expect.any(String),
      },
    })
  })

  it('"Unmark" clears usage and dismisses the detected transaction', async () => {
    const user = userEvent.setup()
    renderRow(
      credit({
        detection_source: 'auto',
        detected_transaction_id: 'txn-1',
        used_amount: 20,
        detection_dismissed_transaction_ids: ['txn-0'],
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Unmark' }))
    expect(mocks.updateCreditMutate).toHaveBeenCalledWith({
      id: 'cr-1',
      patch: {
        used_amount: 0,
        used_at: null,
        detected_transaction_id: null,
        detection_source: null,
        detection_dismissed_transaction_ids: ['txn-0', 'txn-1'],
      },
    })
  })
})
