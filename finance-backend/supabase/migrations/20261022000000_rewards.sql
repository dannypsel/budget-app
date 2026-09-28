-- ============================================================
-- REWARDS (merged Points + Card Credits tab)
--   reward_points: the minimal Points section — program, holder, balance,
--   last-updated; manual entry only (programmatic sync is brittle). Per-program
--   "log spend" subtracts from the balance and is the future hook for the
--   travel app's bookings to auto-decrement via the shared backend.
--
--   churn_credits gains is_hidden (hide used-up / unwanted credits) and
--   program_label (short clear name: "Amex", "United", "Hyatt"). The Rewards
--   hero is credits still needing spend, filtered for unused + sorted by
--   days remaining; card-benefit items (annual fees, 5/24, bonus deadlines)
--   stay in the churning tracker, not here.
--
--   Fresh-DB safe: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY.
--   RLS follows the repo convention: user_id (default auth.uid()) with a flat
--   "own" policy (user_id = auth.uid()) for the authenticated role.
-- ============================================================

create table if not exists reward_points (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  program text not null,
  holder text not null,
  balance numeric(12,2) not null default 0,
  last_updated timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_reward_points_user on reward_points(user_id);

alter table churn_credits
  add column if not exists is_hidden boolean not null default false;
alter table churn_credits
  add column if not exists program_label text;

-- ── RLS (flat "own" policy, like every other table) ─────────────────

alter table reward_points enable row level security;

drop policy if exists "own" on reward_points;
create policy "own" on reward_points for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror the other tables; implicit defaults aren't
-- present on a fresh stack). service_role bypasses RLS; the clients use these.
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on reward_points to authenticated;
