-- ============================================================
-- TRANSACTION AUTO-CLASSIFICATION (need/want + fixed/variable)
--   Every transaction gets need_want ('need'|'want') and spend_pattern
--   ('fixed'|'variable'), auto-decided from category defaults with
--   merchant-level memory and manual per-transaction override.
--
--   transactions.need_want / transactions.spend_pattern are backend-owned
--   (like category_id): the sync pipeline fills them right alongside the
--   category verdict. merchant_txn_tags is the merchant-level memory the
--   frontend upserts on manual override, so the override is remembered going
--   forward — a stored row overrides the category default.
--
--   Fresh-DB safe: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY.
--   New columns inherit the transactions table's existing policies; the memory
--   table gets the flat "own" policy (user_id = auth.uid()) like every other.
-- ============================================================

alter table transactions
  add column if not exists need_want text check (need_want in ('need', 'want'));
alter table transactions
  add column if not exists spend_pattern text check (spend_pattern in ('fixed', 'variable'));

-- Merchant-level tag memory: the normalized merchant key (same normalization
-- as the app's Transaction.merchantKey — lowercased, trimmed merchant_name
-- falling back to description). Backend resolution order: stored row first,
-- then the category default; unknown categories leave the tags null.
create table if not exists merchant_txn_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  merchant_key text not null,
  need_want text check (need_want in ('need', 'want')),
  spend_pattern text check (spend_pattern in ('fixed', 'variable')),
  updated_at timestamptz not null default now(),
  unique (user_id, merchant_key)
);
create index if not exists idx_merchant_txn_tags_user on merchant_txn_tags(user_id);

-- ── RLS (flat "own" policy, like every other table) ─────────────────

alter table merchant_txn_tags enable row level security;

drop policy if exists "own" on merchant_txn_tags;
create policy "own" on merchant_txn_tags for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror the other tables; implicit defaults aren't
-- present on a fresh stack). service_role bypasses RLS; the clients use these.
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on merchant_txn_tags to authenticated;
