-- ============================================================
-- SETTINGS PREFERENCES
--   profiles grows the user-facing preferences the rewritten Settings page
--   edits: display currency, theme choice, and per-type reminder windows
--   (card credits, signup-bonus deadlines, annual-fee/cancel-by dates) with
--   an enabled flag per type. The notify.py scheduler reads these to decide
--   which reminder types to generate and how far out to look.
--   categories gains is_active so archiving a category hides it from pickers
--   and auto-categorization without deleting history.
--
--   Fresh-DB safe: ALTER TABLE … ADD COLUMN IF NOT EXISTS only.
--
--   RLS-safe: profiles and categories already carry the flat "own" policy
--   (id = auth.uid() / user_id = auth.uid()); new columns inherit it — no
--   policy changes needed. service_role bypasses RLS (backend writes).
-- ============================================================

-- ── profiles: display + notification preferences ───────────────────

alter table profiles
  add column if not exists currency text not null default 'USD';
alter table profiles
  add column if not exists theme text not null default 'system';
alter table profiles
  add column if not exists notify_credit_enabled boolean not null default true;
alter table profiles
  add column if not exists notify_credit_days int not null default 7;
alter table profiles
  add column if not exists notify_bonus_enabled boolean not null default true;
alter table profiles
  add column if not exists notify_bonus_days int not null default 14;
alter table profiles
  add column if not exists notify_fee_enabled boolean not null default true;
alter table profiles
  add column if not exists notify_fee_days int not null default 30;

-- ── categories: archiving ──────────────────────────────────────────

alter table categories
  add column if not exists is_active boolean not null default true;

create index if not exists idx_categories_user_active
  on categories(user_id, is_active);
