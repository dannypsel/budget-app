// AI categorization client: on-demand / scheduled classification runs and
// key-presence status. The backend reads API keys from its own env
// (JEV_API_KEY / BRAVE_API_KEY) — this module never sees key values, only
// booleans from GET /categorize/status.

import { supabase } from '@/lib/supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string

/** Pipeline stats returned by POST /categorize/auto. */
export interface AutoCategorizeStats {
  checked: number
  rules_applied: number
  from_cache: number
  ai_applied: number
  needs_review: number
  errors: number
  status?: string
}

/** Ask the backend to run the AI categorization pipeline for the signed-in
 *  user (POST /categorize/auto). Best-effort: returns null when there's no
 *  session or the backend is unreachable — callers treat that as "skipped". */
export async function autoCategorize(): Promise<AutoCategorizeStats | null> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return null
  const res = await fetch(`${BACKEND}/categorize/auto`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return (await res.json().catch(() => null)) as AutoCategorizeStats | null
}

/** Key-presence + preference status for the Settings page
 *  (GET /categorize/status). Never contains key values. */
export interface CategorizeStatus {
  ai_enabled: boolean
  ai_provider: string
  ai_confidence_threshold: number
  jev_key_configured: boolean
  brave_key_configured: boolean
}

export async function fetchCategorizeStatus(): Promise<CategorizeStatus | null> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return null
  const res = await fetch(`${BACKEND}/categorize/status`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return (await res.json().catch(() => null)) as CategorizeStatus | null
}
