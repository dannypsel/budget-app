-- ============================================================
-- SPENDING PLAN + CREDIT-CARD CHURNING TRACKER (schema only)
--   Barebones Simplifi replacement: the spending plan (planned income, monthly
--   bills, savings goals) and a card-churning tracker (cards, signup bonuses,
--   annual credits). Schema only — the backend sync pipeline doesn't write
--   these tables; the clients (web + iOS) manage them directly via PostgREST.
--
--   Fresh-DB safe: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--   DROP POLICY IF EXISTS before CREATE POLICY. GRANTs and ENABLE ROW LEVEL
--   SECURITY are idempotent.
--
--   RLS follows the repo convention: every table carries user_id (default
--   auth.uid()) with a flat "own" policy (user_id = auth.uid()) for the
--   authenticated role; the backend's service_role bypasses RLS.
--
--   NOTE: transactions.exclude_from_totals already exists and serves as the
--   spending-plan "ignore this transaction" flag — no duplicate column here.
-- ============================================================

-- ── Spending plan ──────────────────────────────────────────────

-- One row per user: the planned monthly income the spending plan is built on.
create table if not exists spending_settings (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  planned_monthly_income numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

-- Recurring monthly bills feeding the plan's fixed-expenses section.
create table if not exists bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  amount numeric(12,2) not null,
  due_day int not null check (due_day between 1 and 31),
  category text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_bills_user on bills(user_id);

-- Savings goals: target + monthly contribution the plan carves out.
create table if not exists savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  target_amount numeric(12,2) not null,
  monthly_contribution numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_savings_goals_user on savings_goals(user_id);

-- ── Credit-card churning tracker ───────────────────────────────

-- One row per churned card. account_id optionally links the card to its
-- Plaid-synced accounts row (bonus spend is measured from transactions, so
-- the frontend can cross-reference); on delete set null keeps the card row.
create table if not exists churn_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  card_name text not null,
  issuer text,
  last4 text,
  opened_date date,
  annual_fee numeric(12,2),
  annual_fee_date date,
  cancel_by_date date,
  notes text,
  account_id uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_churn_cards_user on churn_cards(user_id);
create index if not exists idx_churn_cards_account on churn_cards(account_id);

-- Signup / retention bonuses per card: spend $X by date Y to earn the bonus.
-- The frontend computes progress from transactions; the backend doesn't track it.
create table if not exists churn_bonuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  card_id uuid references churn_cards(id) on delete cascade,
  description text not null,
  spend_required numeric(12,2) not null,
  spend_start_date date,
  spend_by_date date not null,
  bonus_value text,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_churn_bonuses_user on churn_bonuses(user_id);
create index if not exists idx_churn_bonuses_card on churn_bonuses(card_id);

-- Annual / semiannual / monthly credits per card (e.g. travel credits):
-- how much is available and how much has been used this cycle.
create table if not exists churn_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  card_id uuid references churn_cards(id) on delete cascade,
  credit_name text not null,
  amount numeric(12,2) not null,
  frequency text not null default 'annual'
    check (frequency in ('annual', 'semiannual', 'monthly')),
  used_amount numeric(12,2) not null default 0,
  reset_date date,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_churn_credits_user on churn_credits(user_id);
create index if not exists idx_churn_credits_card on churn_credits(card_id);

-- ── RLS (flat "own" policy, like every other table) ────────────

alter table spending_settings enable row level security;
alter table bills enable row level security;
alter table savings_goals enable row level security;
alter table churn_cards enable row level security;
alter table churn_bonuses enable row level security;
alter table churn_credits enable row level security;

drop policy if exists "own" on spending_settings;
create policy "own" on spending_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on bills;
create policy "own" on bills for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on savings_goals;
create policy "own" on savings_goals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on churn_cards;
create policy "own" on churn_cards for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on churn_bonuses;
create policy "own" on churn_bonuses for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on churn_credits;
create policy "own" on churn_credits for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror 20260707 / 20260725; implicit defaults aren't
-- present on a fresh stack). service_role bypasses RLS; the clients use these.
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on spending_settings to authenticated;
grant select, insert, update, delete on bills to authenticated;
grant select, insert, update, delete on savings_goals to authenticated;
grant select, insert, update, delete on churn_cards to authenticated;
grant select, insert, update, delete on churn_bonuses to authenticated;
grant select, insert, update, delete on churn_credits to authenticated;
