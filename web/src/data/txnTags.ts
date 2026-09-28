// Transaction need/want + fixed/variable tags, with per-merchant memory.
// A manual override writes the transaction row AND upserts merchant_txn_tags so
// future transactions from the same merchant remember it.

import { supabase } from '@/lib/supabase'
import type { NeedWant, SpendPattern, Transaction } from '@/types/domain'

/** Merchant key for tag memory: lowercase, whitespace and punctuation stripped.
 *  Stricter than merchantKey — "PAYPAL *X" and "paypal x" are the same merchant
 *  for tagging purposes. */
export function normalizeMerchantTagKey(txn: Transaction): string {
  const raw = (txn.merchant_name || txn.description || '').toLowerCase()
  return raw.replace(/[\s\p{P}]/gu, '')
}

export interface TxnTagPatch {
  need_want?: NeedWant | null
  spend_pattern?: SpendPattern | null
}

/** Set a transaction's tags AND remember them for the merchant: update the txn
 *  row, then read-merge-write merchant_txn_tags so overriding one tag keeps the
 *  other tag's learned value. */
export async function setTxnTags(txn: Transaction, patch: TxnTagPatch): Promise<void> {
  const txnPatch: { need_want?: NeedWant | null; spend_pattern?: SpendPattern | null } = {}
  if (patch.need_want !== undefined) txnPatch.need_want = patch.need_want
  if (patch.spend_pattern !== undefined) txnPatch.spend_pattern = patch.spend_pattern
  const { error: txnError } = await supabase
    .from('transactions')
    .update(txnPatch)
    .eq('id', txn.id)
  if (txnError) throw txnError

  const key = normalizeMerchantTagKey(txn)
  if (!key) return
  // Merge with the existing learned row so setting one tag doesn't blank the other.
  const { data: existing } = await supabase
    .from('merchant_txn_tags')
    .select('need_want, spend_pattern')
    .eq('merchant_key', key)
    .maybeSingle()
  const merged = {
    need_want:
      patch.need_want !== undefined ? patch.need_want : (existing?.need_want ?? null),
    spend_pattern:
      patch.spend_pattern !== undefined ? patch.spend_pattern : (existing?.spend_pattern ?? null),
  }
  // user_id defaults to auth.uid() (see learnMerchant); RLS scopes the read.
  const { error: memError } = await supabase.from('merchant_txn_tags').upsert(
    { merchant_key: key, ...merged, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,merchant_key' },
  )
  if (memError) throw memError
}
