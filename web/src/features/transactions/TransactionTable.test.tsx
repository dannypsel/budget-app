import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TransactionTable, type RegisterColumns } from './TransactionTable'
import { groupRegister } from './registerGroups'
import { makeTxn } from '@/test/factories'

const COLS: RegisterColumns = { account: true, reviewed: true, category: true, tags: false, exclusion: true }
const txns = [
  makeTxn({ id: 'p', merchant_name: 'Pending Cafe', pending: true, effective_date: '2026-10-20', amount: 31.01 }),
  makeTxn({ id: 'a', merchant_name: 'Paycheck Co', effective_date: '2026-10-15', amount: -15130.95 }),
  makeTxn({ id: 'b', merchant_name: 'Grocer', effective_date: '2026-09-30', amount: 2059.5, exclude_from_totals: true }),
]

describe('groupRegister', () => {
  it('pins Pending first, then groups by month', () => {
    expect(groupRegister(txns).map(([k, rows]) => [k, rows.map((r) => r.id)])).toEqual([
      ['__pending__', ['p']],
      ['2026-10', ['a']],
      ['2026-09', ['b']],
    ])
  })
})

describe('<TransactionTable>', () => {
  it('renders Simplifi amounts: plain expenses, "+" income, and exclusion labels', () => {
    render(<TransactionTable transactions={txns} accountsById={new Map()} columns={COLS} />)
    expect(screen.getByRole('heading', { name: 'Pending' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument()
    expect(screen.getByText('31.01')).toBeInTheDocument()
    expect(screen.getByText('+15,130.95')).toBeInTheDocument()
    const grocerRow = screen.getByText('Grocer').closest('tr')!
    expect(within(grocerRow).getByText('Excluded')).toBeInTheDocument()
  })

  it('collapses a month group and sorts from the header', async () => {
    const onSort = vi.fn()
    render(<TransactionTable transactions={txns} accountsById={new Map()} columns={COLS} onSortChange={onSort} />)
    await userEvent.click(screen.getByRole('heading', { name: 'September 2026' }))
    expect(screen.queryByText('Grocer')).not.toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Sort by amount'))
    expect(onSort).toHaveBeenCalledWith('amount-desc')
  })
})
