-- ============================================================
-- FORECAST + BUDGETS + RETIREMENT SCENARIOS
--   budgets: monthly per-category budgets (planned-vs-actual progress bars,
--   month navigation, editable targets, over-budget flags). Category budget
--   totals feed the Overview spending plan and the forecast baseline.
--
--   forecast_adjustments: explicit recurring / one-time events the forecast
--   layers on top of the (budget-based, spending-plan) baseline — income or
--   spending, with a month range (recurring) or a single month (one_time).
--
--   retirement_scenarios: named, saved what-if scenarios for the retirement
--   tab (interactive inputs as JSONB so the scenario model can evolve without
--   schema churn); side-by-side comparison reads these rows.
--
--   Fresh-DB safe: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS,
--   DROP POLICY IF EXISTS before CREATE POLICY. RLS follows the repo
--   convention: user_id (default auth.uid()) with a flat "own" policy
--   (user_id = auth.uid()) for the authenticated role; service_role bypasses.
-- ============================================================

-- One budget target per user / month (first-of-month date) / category.
create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month date not null,
  category text not null,
  target numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, month, category)
);
create index if not exists idx_budgets_user on budgets(user_id);
create index if not exists idx_budgets_user_month on budgets(user_id, month);

-- Forecast events layered on the spending-plan surplus baseline.
-- kind='recurring': start_month..end_month range; kind='one_time': month only.
create table if not exists forecast_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('recurring', 'one_time')),
  direction text not null check (direction in ('income', 'spending')),
  name text not null,
  amount numeric(12,2) not null,
  start_month date,
  end_month date,
  month date,
  created_at timestamptz not null default now()
);
create index if not exists idx_forecast_adjustments_user on forecast_adjustments(user_id);

-- Saved named retirement what-if scenarios; inputs stored as JSONB so the
-- model (spending pre/post, tax rate, plan-through age, account buckets...)
-- can evolve without schema churn.
create table if not exists retirement_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  inputs jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_retirement_scenarios_user on retirement_scenarios(user_id);

-- ── RLS (flat "own" policy, like every other table) ─────────────────

alter table budgets enable row level security;
alter table forecast_adjustments enable row level security;
alter table retirement_scenarios enable row level security;

drop policy if exists "own" on budgets;
create policy "own" on budgets for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on forecast_adjustments;
create policy "own" on forecast_adjustments for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own" on retirement_scenarios;
create policy "own" on retirement_scenarios for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror the other tables; implicit defaults aren't
-- present on a fresh stack). service_role bypasses RLS; the clients use these.
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on budgets to authenticated;
grant select, insert, update, delete on forecast_adjustments to authenticated;
grant select, insert, update, delete on retirement_scenarios to authenticated;
