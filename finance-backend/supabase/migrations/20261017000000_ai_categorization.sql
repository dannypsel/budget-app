-- ============================================================
-- AI TRANSACTION CATEGORIZATION
--   profiles gains the user-facing AI preferences the Settings page edits:
--   ai_enabled (master switch), ai_provider ('jev' | 'gemini' | 'off'),
--   ai_confidence_threshold (0..1, default 0.7 — auto-apply at or above).
--   API keys stay in backend env vars (JEV_API_KEY / GEMINI_API_KEY /
--   BRAVE_API_KEY), never in the DB; the backend reports key *presence*
--   only via /categorize/status.
--
--   ai_category_cache: normalized-merchant → last AI verdict, so repeat
--   merchants never re-call the model. Written by the sync service
--   (service_role); users read their own rows.
--
--   transactions gains ai_confidence + ai_source so an AI-applied category
--   is distinguishable from a rule/learned one (and re-runnable).
--
--   Fresh-DB safe: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--   RLS-safe: cache table gets the flat "own rows" policy
--   (user_id = auth.uid()); new columns inherit existing policies.
-- ============================================================

-- ── profiles: AI preferences ────────────────────────────────────

alter table profiles
  add column if not exists ai_enabled boolean not null default true;
alter table profiles
  add column if not exists ai_provider text not null default 'jev';
alter table profiles
  add column if not exists ai_confidence_threshold double precision not null default 0.7;

-- ── ai_category_cache ───────────────────────────────────────────

create table if not exists ai_category_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_key text not null,
  category_id uuid references categories(id) on delete set null,
  confidence double precision,
  source text not null default 'jev',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, merchant_key)
);

create index if not exists idx_ai_category_cache_user
  on ai_category_cache(user_id);

alter table ai_category_cache enable row level security;

drop policy if exists ai_category_cache_own on ai_category_cache;
create policy ai_category_cache_own on ai_category_cache
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── transactions: AI verdict provenance ─────────────────────────

alter table transactions
  add column if not exists ai_confidence double precision;
alter table transactions
  add column if not exists ai_source text;
