-- ============================================================
-- PROFILES: WATCHED CATEGORIES (spending plan)
--   The Overview spending plan shows only a configurable subset of
--   categories, editable via a multi-select in Settings. Default:
--   groceries, shopping, eating out, pregnancy craving.
--
--   Fresh-DB safe: ADD COLUMN IF NOT EXISTS. The profiles "own" policy
--   (id = auth.uid()) already covers the new column.
-- ============================================================

alter table profiles
  add column if not exists watched_categories text[] not null
    default '{"groceries","shopping","eating out","pregnancy craving"}';
