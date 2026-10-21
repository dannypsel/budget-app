import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TransactionList, groupByDay } from './TransactionList'
import { makeTxn, makeCategory } from '@/test/factories'

describe('groupByDay', () => {
  it('puts pending rows in a leading Pending group regardless of date', () => {
    const groups = groupByDay([
      makeTxn({ id: 'a', effective_date: '2026-06-03' }),
      makeTxn({ id: 'b', effective_date: '2026-06-01', pending: true }),
    ])
    expect(groups.map(([k, rows]) => [k, rows.map((r) => r.id)])).toEqual([
      ['__pending__', ['b']],
      ['2026-06-03', ['a']],
    ])
  })

  it('groups transactions by effective_date, preserving order', () => {
    const txns = [
      makeTxn({ id: 'a', effective_date: '2026-06-15' }),
      makeTxn({ id: 'b', effective_date: '2026-06-15' }),
      makeTxn({ id: 'c', effective_date: '2026-06-14' }),
    ]
    const groups = groupByDay(txns)
    expect(groups.map(([day]) => day)).toEqual(['2026-06-15', '2026-06-14'])
    expect(groups[0][1]).toHaveLength(2)
  })
})

describe('<TransactionList>', () => {
  it('renders rows with merchant + category and fires onSelect', async () => {
    const onSelect = vi.fn()
    const txns = [
      makeTxn({ id: 'a', merchant_name: 'Whole Foods', categories: makeCategory({ name: 'Groceries' }) }),
    ]
    render(<TransactionList transactions={txns} onSelect={onSelect} />)

    expect(screen.getByText('Whole Foods')).toBeInTheDocument()
    expect(screen.getByText('Groceries')).toBeInTheDocument()

    await userEvent.click(screen.getByText('Whole Foods'))
    expect(onSelect).toHaveBeenCalledWith(txns[0])
  })

  it('shows a Pending tag and pins pending rows under a Pending header', () => {
    render(<TransactionList transactions={[makeTxn({ pending: true })]} />)
    expect(screen.getByRole('heading', { name: 'Pending' })).toBeInTheDocument()
    expect(screen.getAllByText('Pending')).toHaveLength(2)
  })

  it('renders a "Reimbursement · <Category>" badge for a reimbursement credit', () => {
    render(
      <TransactionList
        transactions={[
          makeTxn({
            id: 'zelle',
            amount: -1500,
            merchant_name: 'Roommate',
            is_reimbursement: true,
            categories: makeCategory({ name: 'Rent' }),
          }),
        ]}
      />,
    )
    expect(screen.getByText('Reimbursement · Rent')).toBeInTheDocument()
  })
})
