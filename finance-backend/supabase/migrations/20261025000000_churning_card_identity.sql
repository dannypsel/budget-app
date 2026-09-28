-- ============================================================
-- CHURNING CARD IDENTITY (owner name + last 5 digits)
--   Card identity = product name + last 5 digits + owner full name (so you
--   know whose physical card to grab; all money and spending is combined, so
--   there is no per-person "should use" split).
--
--   Plaid's account mask only exposes the last 4 digits — the frontend
--   auto-fills those 4 and the 5th digit is a one-time manual entry when
--   adding the card (or all 5 typed manually). No backend work beyond these
--   columns; the sync pipeline and credit detector are untouched.
--
--   Fresh-DB safe: ADD COLUMN IF NOT EXISTS. Existing policies on
--   churn_cards cover the new columns.
-- ============================================================

alter table churn_cards
  add column if not exists owner_name text;
alter table churn_cards
  add column if not exists last5 text;
