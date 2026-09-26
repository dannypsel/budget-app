// Backend-generated notifications (credit expiry, bonus deadlines, annual fees,
// cancel-by reminders). Direct PostgREST; every query explicitly filters user_id
// to the caller, and RLS (user_id = auth.uid()) remains as defense in depth.

import { supabase } from '@/lib/supabase'
import type { UserNotification, UUID } from '@/types/domain'

/** The signed-in user's id, or throw. Every query scopes to this — RLS stays on
 *  as defense in depth, but the client never relies on it alone. */
async function requireUserId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  return userId
}

/** All of the caller's notifications, newest first. */
export async function fetchNotifications(): Promise<UserNotification[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as UserNotification[]
}

/** Mark one notification read. */
export async function markNotificationRead(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

/** Mark every unread notification read. */
export async function markAllNotificationsRead(): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false)
  if (error) throw error
}
