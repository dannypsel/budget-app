import { createClient } from '@supabase/supabase-js'

// Same Supabase project as the iOS app. The publishable key is safe in the browser bundle —
// Row Level Security scopes every row to the signed-in user (user_id = auth.uid()),
// exactly as the iOS app relies on (PocketLens/Config/Supabase.swift).
const url = import.meta.env.VITE_SUPABASE_URL as string
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

if (!url || !publishableKey) {
  // Surface a clear error instead of a cryptic network failure later.
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. Copy web/.env.example to web/.env.',
  )
}

export const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Parse the token from password-recovery / email-confirmation links so the client
    // establishes a session and fires PASSWORD_RECOVERY (see lib/auth.tsx).
    detectSessionInUrl: true,
    // Implicit flow puts the token in the URL hash, so a recovery link works even when
    // opened in a different browser than the one that requested it (email on phone,
    // app on desktop). PKCE would tie recovery to the requesting browser's stored
    // code_verifier. Google OAuth also lands its token in the hash, and
    // detectSessionInUrl picks up the same-browser redirect — so implicit stays fine.
    flowType: 'implicit',
  },
})
