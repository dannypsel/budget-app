-- ============================================================
-- DISCRETIONARY (DARA GAME WINS) TRACKER
--   Game winnings / discretionary budget tracker. Daniel vs Sara
--   games/challenges/bets: win-loss-tie stats plus per-person discretionary
--   balances EXCLUDED from household totals and the spending plan.
--
--   Signed payouts: one ledger row holds both sides (e.g. Daniel −$10 /
--   Sara +$10); balances = per-person sums. Original Google Sheet stays
--   linked/viewable from inside the app; the sheet's ledger rows
--   (game / purchase / challenge / bet) are modeled 1:1 here.
--
--   Fresh-DB safe: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--   DROP POLICY IF EXISTS before CREATE POLICY. RLS follows the repo
--   convention: user_id (default auth.uid()) with a flat "own" policy
--   (user_id = auth.uid()) for the authenticated role; service_role bypasses.
-- ============================================================

-- Game types (e.g. Dominion, Ping Pong); new types are managed in Settings.
create table if not exists discretionary_game_types (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists idx_discretionary_game_types_user on discretionary_game_types(user_id);

-- Ledger of game results (payout, winner/tie), purchases (outflow),
-- challenges/bets (inflow), and manual adjustments. daniel_amount /
-- sara_amount apply directly to each person's discretionary balance.
create table if not exists discretionary_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  occurred_on date not null,
  entry_type text not null
    check (entry_type in ('game', 'purchase', 'challenge', 'bet', 'adjustment')),
  game_type_id uuid references discretionary_game_types(id) on delete set null,
  winner text check (winner in ('daniel', 'sara', 'tie')),
  payout numeric(12,2),
  daniel_amount numeric(12,2) not null default 0,
  sara_amount numeric(12,2) not null default 0,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_discretionary_ledger_user on discretionary_ledger(user_id);
create index if not exists idx_discretionary_ledger_game_type on discretionary_ledger(game_type_id);

-- ── RLS (flat "own" policy, like every other table) ─────────────────

alter table discretionary_game_types enable row level security;
alter table discretionary_ledger enable row level security;

drop policy if exists "own" on discretionary_game_types;
create policy "own" on discretionary_game_types for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on discretionary_ledger;
create policy "own" on discretionary_ledger for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror the other tables; implicit defaults aren't
-- present on a fresh stack). service_role bypasses RLS; the clients use these.
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on discretionary_game_types to authenticated;
grant select, insert, update, delete on discretionary_ledger to authenticated;
