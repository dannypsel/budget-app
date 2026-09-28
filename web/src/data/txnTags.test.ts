import { describe, expect, it } from 'vitest'
import { normalizeMerchantTagKey } from './txnTags'
import type { Transaction } from '@/types/domain'

const txn = (merchant_name: string | null, description: string | null): Transaction =>
  ({
    id: 't',
    merchant_name,
    description,
  }) as Transaction

describe('normalizeMerchantTagKey', () => {
  it('lowercases and strips whitespace and punctuation', () => {
    expect(normalizeMerchantTagKey(txn('  PAYPAL *Xfer ', null))).toBe('paypalxfer')
    expect(normalizeMerchantTagKey(txn(null, "Trader Joe's #123"))).toBe('traderjoes123')
  })

  it('prefers merchant_name over description', () => {
    expect(normalizeMerchantTagKey(txn('Amazon', 'AMZN MKTP'))).toBe('amazon')
  })

  it('returns empty string when there is no merchant identity', () => {
    expect(normalizeMerchantTagKey(txn(null, null))).toBe('')
  })
})
