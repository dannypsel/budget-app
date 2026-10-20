-- ============================================================
-- TRANSACTION REVIEWED FLAG (Simplifi parity)
--   Simplifi tracks "reviewed" separately from categorized and from
--   Pending/Cleared status: a per-transaction check the user toggles once
--   they've eyeballed the row, powering the "Unreviewed" quick filter and
--   the Dashboard review widget. PocketLens had no equivalent — the
--   categorize queue conflated the two.
--
--   `reviewed` is user-owned (like hidden): default false, the sync
--   pipeline never writes it. Fresh-DB safe: ADD COLUMN IF NOT EXISTS.
--   The column inherits the transactions table's existing RLS policies
--   and grants.
-- ============================================================

alter table transactions
  add column if not exists reviewed boolean not null default false;
