import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logRows: { status: string; started_at: string; finished_at: string | null; error_message: string | null; transactions_added: number; transactions_modified: number }[][] = []

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
    from: () => ({
      select: () => ({
        gte: () => ({
          order: () => ({ limit: async () => ({ data: logRows.shift() ?? [], error: null }) }),
        }),
      }),
    }),
  },
}))
vi.mock('@/data/backend', () => ({ warm: vi.fn().mockResolvedValue(undefined) }))

import { __runSyncForTest, triggerSync } from './sync'

const noSleep = () => Promise.resolve()
const row = (status: string, added = 0) => [
  { status, started_at: new Date().toISOString(), finished_at: status === 'running' ? null : 'x', error_message: null, transactions_added: added, transactions_modified: 0 },
]

describe('triggerSync', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    logRows.length = 0
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs once and returns the inline summary', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok', items_synced: 5, transactions_added: 3 }), { status: 200 }))
    await expect(__runSyncForTest(noSleep)).resolves.toMatchObject({ items_synced: 5, transactions_added: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('after a gateway timeout, follows sync_log instead of re-POSTing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    logRows.push(row('running'), row('running'), row('success', 4))
    await expect(__runSyncForTest(noSleep)).resolves.toMatchObject({ status: 'success', transactions_added: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a server-side sync error', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }))
    logRows.push(row('error'))
    await expect(__runSyncForTest(noSleep)).rejects.toThrow('Sync failed on the server')
  })

  it('shares one run between concurrent callers', async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)))
    const a = triggerSync()
    const b = triggerSync()
    expect(a).toBe(b)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    await expect(a).resolves.toMatchObject({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
