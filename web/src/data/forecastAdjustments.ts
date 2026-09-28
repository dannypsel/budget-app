// Forecast adjustments — named tweaks layered onto the forecast baseline.
// Direct PostgREST; every query explicitly filters user_id to the caller, RLS
// stays on as defense in depth.

import { supabase } from '@/lib/supabase'
import type { ForecastAdjustment, ForecastAdjustmentInsert, UUID } from '@/types/domain'

async function requireUserId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) throw new Error('Not signed in')
  return userId
}

/** All of the caller's forecast adjustments, recurring first then by name. */
export async function fetchForecastAdjustments(): Promise<ForecastAdjustment[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('forecast_adjustments')
    .select('*')
    .eq('user_id', userId)
    .order('kind', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as ForecastAdjustment[]
}

export async function createForecastAdjustment(
  input: ForecastAdjustmentInsert,
): Promise<ForecastAdjustment> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('forecast_adjustments')
    .insert({ ...input, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as ForecastAdjustment
}

export async function updateForecastAdjustment(
  id: UUID,
  patch: Partial<ForecastAdjustmentInsert>,
): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('forecast_adjustments')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

export async function deleteForecastAdjustment(id: UUID): Promise<void> {
  const userId = await requireUserId()
  const { error } = await supabase
    .from('forecast_adjustments')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}
