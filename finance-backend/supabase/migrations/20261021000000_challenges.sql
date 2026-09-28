-- ============================================================
-- CHALLENGES (recurring personal challenges between Daniel and Sara)
--   Head-to-head / habit challenges with per-day check-ins, reward payouts,
--   and an active → completed/failed/overridden lifecycle. challenge_checkins
--   records which days the person checked in; discretionary_ledger.challenge_id
--   links any ledger payout (or penalty) to the challenge that produced it.
--
--   Fresh-DB safe: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY.
--   RLS follows the repo convention: user_id (default auth.uid()) with a flat
--   "own" policy (user_id = auth.uid()) for the authenticated role.
-- ============================================================

create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  person text not null check (person in ('daniel', 'sara')),
  title text not null,
  start_date date not null,
  end_date date not null,
  frequency text not null default 'daily'
    check (frequency in ('daily', 'weekly')),
  times_per_week int,
  reward numeric(12,2) not null default 0,
  grace_days int not null default 0,
  status text not null default 'active'
    check (status in ('active', 'completed', 'failed', 'overridden')),
  created_at timestamptz not null default now()
);
create index if not exists idx_challenges_user on challenges(user_id);

create table if not exists challenge_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  challenge_id uuid not null references challenges(id) on delete cascade,
  checkin_date date not null,
  created_at timestamptz not null default now(),
  unique (challenge_id, checkin_date)
);
create index if not exists idx_challenge_checkins_challenge on challenge_checkins(challenge_id);
create index if not exists idx_challenge_checkins_user on challenge_checkins(user_id);

-- Link ledger entries (payouts/penalties) back to the challenge that made them.
alter table discretionary_ledger
  add column if not exists challenge_id uuid references challenges(id) on delete set null;
create index if not exists idx_discretionary_ledger_challenge on discretionary_ledger(challenge_id);

-- ── RLS (flat "own" policy, like every other table) ─────────────────

alter table challenges enable row level security;
alter table challenge_checkins enable row level security;

drop policy if exists "own" on challenges;
create policy "own" on challenges for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on challenge_checkins;
create policy "own" on challenge_checkins for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror the other tables; implicit defaults aren't
-- present on a fresh stack). service_role bypasses RLS; the clients use these.
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on challenges to authenticated;
grant select, insert, update, delete on challenge_checkins to authenticated;
