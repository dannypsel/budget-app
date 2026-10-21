// Simplifi transaction extras: color flag + note, memo (notes), user tags,
// split editor writes, and file attachments (private "attachments" bucket,
// objects under <user id>/<txn id>/…; RLS + storage policies scope both to
// the owner — see migration 20261101000000).

import { supabase } from '@/lib/supabase'
import type { Tag, TransactionAttachment, UserFlag, UUID } from '@/types/domain'

export async function setTxnFlag(id: UUID, flag: UserFlag | null, note: string | null): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ user_flag: flag, user_flag_note: flag ? note : null })
    .eq('id', id)
  if (error) throw error
}

export async function setTxnNotes(id: UUID, notes: string): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ notes: notes.trim() === '' ? null : notes })
    .eq('id', id)
  if (error) throw error
}

export async function fetchTags(): Promise<Tag[]> {
  const { data, error } = await supabase.from('tags').select('*').order('name')
  if (error) throw error
  return (data ?? []) as Tag[]
}

/** Attach a tag by name, creating the tag when the user has none with that name. */
export async function addTxnTagByName(txnId: UUID, name: string, color: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  const { data: existing, error: findError } = await supabase
    .from('tags')
    .select('id')
    .ilike('name', trimmed)
    .maybeSingle()
  if (findError) throw findError
  let tagId = (existing as { id: UUID } | null)?.id
  if (!tagId) {
    const { data, error } = await supabase.from('tags').insert({ name: trimmed, color }).select('id').single()
    if (error) throw error
    tagId = (data as { id: UUID }).id
  }
  const { error } = await supabase
    .from('transaction_tags')
    .upsert({ transaction_id: txnId, tag_id: tagId }, { onConflict: 'transaction_id,tag_id' })
  if (error) throw error
}

export async function removeTxnTag(txnId: UUID, tagId: UUID): Promise<void> {
  const { error } = await supabase.from('transaction_tags').delete().eq('transaction_id', txnId).eq('tag_id', tagId)
  if (error) throw error
}

export interface SplitInput {
  category_id: UUID
  amount: number
}

/** Splits must sum to the transaction amount (to the cent) — the table relies on
 *  the client for this invariant. An empty list removes the split. */
export function splitRemainder(txnAmount: number, splits: { amount: number }[]): number {
  return Math.round((txnAmount - splits.reduce((s, x) => s + x.amount, 0)) * 100) / 100
}

export async function replaceSplits(txnId: UUID, txnAmount: number, splits: SplitInput[]): Promise<void> {
  if (splits.length > 0 && splitRemainder(txnAmount, splits) !== 0) {
    throw new Error('Split amounts must add up to the transaction amount')
  }
  const { error: delError } = await supabase.from('transaction_splits').delete().eq('transaction_id', txnId)
  if (delError) throw delError
  if (splits.length === 0) return
  const { error } = await supabase
    .from('transaction_splits')
    .insert(splits.map((s) => ({ transaction_id: txnId, category_id: s.category_id, amount: s.amount })))
  if (error) throw error
}

// ── attachments ──────────────────────────────────────────────────────────

const BUCKET = 'attachments'
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export async function fetchAttachments(txnId: UUID): Promise<TransactionAttachment[]> {
  const { data, error } = await supabase
    .from('transaction_attachments')
    .select('*')
    .eq('transaction_id', txnId)
    .order('created_at')
  if (error) throw error
  return (data ?? []) as TransactionAttachment[]
}

/** txn id → attachment count, for the register's paperclip marker. */
export async function fetchAttachmentCounts(): Promise<Map<UUID, number>> {
  const { data, error } = await supabase.from('transaction_attachments').select('transaction_id')
  if (error) throw error
  const out = new Map<UUID, number>()
  for (const r of (data ?? []) as { transaction_id: UUID }[]) out.set(r.transaction_id, (out.get(r.transaction_id) ?? 0) + 1)
  return out
}

export async function uploadAttachment(txnId: UUID, file: File): Promise<void> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachments are limited to 10 MB')
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file'
  const path = `${userId}/${txnId}/${crypto.randomUUID()}-${safeName}`
  const { error: upError } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  })
  if (upError) throw upError
  const { error } = await supabase.from('transaction_attachments').insert({
    transaction_id: txnId,
    storage_path: path,
    file_name: file.name,
    content_type: file.type || null,
    size_bytes: file.size,
  })
  if (error) {
    await supabase.storage.from(BUCKET).remove([path])
    throw error
  }
}

/** Short-lived signed URL (5 minutes) — the bucket is private. */
export async function attachmentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
}

export async function deleteAttachment(a: TransactionAttachment): Promise<void> {
  const { error: rmError } = await supabase.storage.from(BUCKET).remove([a.storage_path])
  if (rmError) throw rmError
  const { error } = await supabase.from('transaction_attachments').delete().eq('id', a.id)
  if (error) throw error
}
