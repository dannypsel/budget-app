// Saved retirement scenarios — direct PostgREST. The model inputs are stored
// as JSONB; every query explicitly filters user_id to the caller, RLS stays
// on as defense in depth.

import { supabase } from '@/lib/supabase'
import type { RetirementInputs, RetirementScenario, UUID } from '@/types/domain'

async function requireUserId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  return userId
}

/** All of the caller's saved scenarios, newest first. */
export async function fetchRetirementScenarios(): Promise<RetirementScenario[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('retirement_scenarios')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as RetirementScenario[]
}

export async function createRetirementScenario(
  name: string,
  inputs: RetirementInputs,
): Promise<RetirementScenario> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('retirement_scenarios')
    .insert({ user_id: userId, name, inputs })
    .select()
    .single()
  if (error) throw error
  return data as RetirementScenario
}

export async function updateRetirementScenario(
  id: UUID,
  patch: { name?: string; inputs?: RetirementInputs },
): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('retirement_scenarios')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

export async function deleteRetirementScenario(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('retirement_scenarios')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}
