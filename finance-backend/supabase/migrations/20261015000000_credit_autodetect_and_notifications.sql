-- ============================================================
-- CREDIT AUTO-DETECTION + NOTIFICATIONS
--   churn_credits grows the auto-detection columns (merchant keywords, target
--   amount + tolerance, detected-transaction linkage, per-cycle state) so the
--   backend can mark a credit used when its statement credit posts.
--   `notifications` holds in-app reminders (credit expiries, bonus deadlines,
--   annual fees, cancel-by dates); rows are deduped per (user_id, dedup_key)
--   so a period never notifies twice. profiles gains the email-digest opt-in.
--
--   Fresh-DB safe: CREATE TABLE IF NOT EXISTS, ALTER TABLE … ADD COLUMN IF
--   NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY. GRANTs and ENABLE
--   ROW LEVEL SECURITY are idempotent.
--
--   RLS follows the repo convention: flat "own" policy (user_id = auth.uid())
--   for the authenticated role; the backend's service_role bypasses RLS.
-- ============================================================

-- ── churn_credits: auto-detection columns ───────────────────────

alter table churn_credits
  add column if not exists auto_detect boolean not null default true;
alter table churn_credits
  add column if not exists detect_merchant_keywords text[] not null default '{}';
alter table churn_credits
  add column if not exists detect_amount numeric(12,2);
alter table churn_credits
  add column if not exists detect_tolerance numeric(12,2) not null default 0.01;
alter table churn_credits
  add column if not exists used_at timestamptz;
alter table churn_credits
  add column if not exists detected_transaction_id uuid
    references transactions(id) on delete set null;
alter table churn_credits
  add column if not exists detection_source text
    check (detection_source in ('auto', 'manual'));
alter table churn_credits
  add column if not exists detection_dismissed_transaction_ids uuid[]
    not null default '{}';
alter table churn_credits
  add column if not exists remind_days_before int not null default 7;
alter table churn_credits
  add column if not exists period_start_date date;

create index if not exists idx_churn_credits_detected_txn
  on churn_credits(detected_transaction_id);

-- ── notifications ──────────────────────────────────────────────

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  type text not null
    check (type in ('credit_expiry', 'bonus_deadline', 'annual_fee', 'cancel_by')),
  title text not null,
  body text,
  data jsonb not null default '{}',
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  dedup_key text not null,
  unique (user_id, dedup_key)
);
create index if not exists idx_notifications_user on notifications(user_id, created_at desc);

-- ── profiles: email-digest opt-in ──────────────────────────────

alter table profiles
  add column if not exists notify_email_enabled boolean not null default false;

-- ── RLS (flat "own" policy, like every other table) ─────────────

alter table notifications enable row level security;

drop policy if exists "own" on notifications;
create policy "own" on notifications for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror the other migrations; implicit defaults aren't
-- present on a fresh stack). service_role bypasses RLS; the clients use these.
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on notifications to authenticated;
