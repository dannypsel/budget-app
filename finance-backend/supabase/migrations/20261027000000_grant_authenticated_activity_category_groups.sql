-- ============================================================
-- GRANT authenticated DML on activity_log + category_groups
--   Both tables are read/written directly by the web client
--   (web/src/data/activity.ts, web/src/data/categoryGroups.ts) via
--   PostgREST, so the authenticated role needs table privileges.
--   They were created by migrations that predate / missed the grant
--   loop in 20260707000000_api_role_grants.sql. RLS "own" policies
--   already gate every row; these grants only open the door, mirroring
--   the convention used by the feature migrations.
-- ============================================================

grant select, insert, update, delete on activity_log to authenticated;
grant select, insert, update, delete on category_groups to authenticated;
