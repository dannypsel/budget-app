-- ============================================================
-- SIMPLIFI CATEGORY SEED
--   Seeds Daniel's Simplifi 12-month category list (from his screenshot)
--   into every existing user's categories, merged with the seeded
--   defaults — never clobbering anything custom:
--
--     * 'Dining'    -> renamed to 'Dining & Drinks'  (keeps its id, so
--     * 'Transport' -> renamed to 'Auto & Transport'  merchant memory,
--       category rules, budgets and transactions keep working)
--
--   A rename only happens when the target name does NOT already exist
--   for that user (case-insensitive). New names are inserted only when
--   missing per user (case-insensitive), so re-running is a no-op.
--
--   Deliberately NOT seeded:
--     * 'Uncategorized' — the app already renders a null category_id as
--       an "Uncategorized" badge; a second row with that name would be
--       ambiguous.
--     * Nothing is deleted or overwritten: custom categories, colors and
--       icons the user set are left alone. 'Other' keeps its name because
--       categorySuggester falls back to it by name.
--
--   The monthly budgets table keys targets by category NAME, so budget
--   rows are renamed alongside the categories (guarded by the same
--   conditions plus a unique-conflict guard).
--
--   The signup trigger is updated so future users get the same list.
-- ============================================================

-- ── 1. Guarded renames of the two seeded defaults ───────────────────

update categories c
set name = 'Dining & Drinks'
where lower(c.name) = 'dining'
  and not exists (
    select 1 from categories x
    where x.user_id = c.user_id
      and lower(x.name) = 'dining & drinks'
  );

update categories c
set name = 'Auto & Transport'
where lower(c.name) = 'transport'
  and not exists (
    select 1 from categories x
    where x.user_id = c.user_id
      and lower(x.name) = 'auto & transport'
  );

-- ── 2. Rename budget targets alongside (budgets.category is a name) ──
-- Only when the new-shape budgets table (category text) is present.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'budgets'
      and column_name = 'category'
  ) then
    update budgets b
    set category = 'Dining & Drinks'
    where b.category = 'Dining'
      and exists (
        select 1 from categories c
        where c.user_id = b.user_id and c.name = 'Dining & Drinks'
      )
      and not exists (
        select 1 from budgets b2
        where b2.user_id = b.user_id
          and b2.month = b.month
          and b2.category = 'Dining & Drinks'
      );

    update budgets b
    set category = 'Auto & Transport'
    where b.category = 'Transport'
      and exists (
        select 1 from categories c
        where c.user_id = b.user_id and c.name = 'Auto & Transport'
      )
      and not exists (
        select 1 from budgets b2
        where b2.user_id = b.user_id
          and b2.month = b.month
          and b2.category = 'Auto & Transport'
      );
  end if;
end $$;

-- ── 3. Insert the full canonical list where missing (per user) ──────

insert into categories (user_id, name, color, icon, kind, sort_order)
select u.id, v.name, v.color, v.icon, v.kind, v.sort_order
from auth.users u
cross join (values
  ('Groceries',           '#34C759', 'cart.fill',                 'spend',   0),
  ('Dining & Drinks',     '#FF9500', 'fork.knife',               'spend',   1),
  ('Rent',                '#FF3B30', 'house.fill',               'spend',   2),
  ('Utilities',           '#5AC8FA', 'bolt.fill',                'spend',   3),
  ('Auto & Transport',    '#007AFF', 'car.fill',                 'spend',   4),
  ('Home',                '#7DD3FC', 'house.fill',               'spend',   5),
  ('Health',              '#FB923C', 'heart.fill',               'spend',   6),
  ('Charity & Donations', '#FACC15', 'gift.fill',                'spend',   7),
  ('Education',           '#8B5CF6', 'graduationcap.fill',       'spend',   8),
  ('Travel',              '#F87171', 'ticket.fill',              'spend',   9),
  ('Shopping',            '#C084FC', 'bag.fill',                 'spend',  10),
  ('Taxes',               '#EF4444', 'building.columns.fill',    'spend',  11),
  ('Polie Business',      '#3B82F6', 'briefcase.fill',           'spend',  12),
  ('Other',               '#98989D', 'tag.fill',                 'spend',  13),
  ('Fees & Charges',      '#67E8F9', 'creditcard.fill',          'spend',  14),
  ('Entertainment',       '#FB923C', 'popcorn.fill',             'spend',  15),
  ('Sara',                '#FACC15', 'tag.fill',                 'spend',  16),
  ('Subscriptions',       '#8B5CF6', 'newspaper.fill',           'spend',  17),
  ('Pets',                '#F87171', 'pawprint.fill',            'spend',  18),
  ('Cash & ATM',          '#C084FC', 'banknote.fill',            'spend',  19),
  ('Financial',           '#A3E635', 'chart.line.uptrend.xyaxis','spend',  20),
  ('Daniel',              '#EF4444', 'tag.fill',                 'spend',  21),
  ('Hobby',               '#3B82F6', 'gamecontroller.fill',      'spend',  22),
  ('Transfer',            '#6366F1', 'tram.fill',                'spend',  23),
  ('Income',              '#32D74B', 'dollarsign.circle.fill',   'income', 200)
) as v(name, color, icon, kind, sort_order)
where not exists (
  select 1 from categories c
  where c.user_id = u.id
    and lower(c.name) = lower(v.name)
);

-- ── 4. Future users get the same list from the signup trigger ────────

create or replace function seed_default_categories()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into categories (user_id, name, color, icon, kind, sort_order) values
    (new.id, 'Groceries',           '#34C759', 'cart.fill',                 'spend',   0),
    (new.id, 'Dining & Drinks',     '#FF9500', 'fork.knife',               'spend',   1),
    (new.id, 'Rent',                '#FF3B30', 'house.fill',               'spend',   2),
    (new.id, 'Utilities',           '#5AC8FA', 'bolt.fill',                'spend',   3),
    (new.id, 'Auto & Transport',    '#007AFF', 'car.fill',                 'spend',   4),
    (new.id, 'Home',                '#7DD3FC', 'house.fill',               'spend',   5),
    (new.id, 'Health',              '#FB923C', 'heart.fill',               'spend',   6),
    (new.id, 'Charity & Donations', '#FACC15', 'gift.fill',                'spend',   7),
    (new.id, 'Education',           '#8B5CF6', 'graduationcap.fill',       'spend',   8),
    (new.id, 'Travel',              '#F87171', 'ticket.fill',              'spend',   9),
    (new.id, 'Shopping',            '#C084FC', 'bag.fill',                 'spend',  10),
    (new.id, 'Taxes',               '#EF4444', 'building.columns.fill',    'spend',  11),
    (new.id, 'Polie Business',      '#3B82F6', 'briefcase.fill',           'spend',  12),
    (new.id, 'Other',               '#98989D', 'tag.fill',                 'spend',  13),
    (new.id, 'Fees & Charges',      '#67E8F9', 'creditcard.fill',          'spend',  14),
    (new.id, 'Entertainment',       '#FB923C', 'popcorn.fill',             'spend',  15),
    (new.id, 'Sara',                '#FACC15', 'tag.fill',                 'spend',  16),
    (new.id, 'Subscriptions',       '#8B5CF6', 'newspaper.fill',           'spend',  17),
    (new.id, 'Pets',                '#F87171', 'pawprint.fill',            'spend',  18),
    (new.id, 'Cash & ATM',          '#C084FC', 'banknote.fill',            'spend',  19),
    (new.id, 'Financial',           '#A3E635', 'chart.line.uptrend.xyaxis','spend',  20),
    (new.id, 'Daniel',              '#EF4444', 'tag.fill',                 'spend',  21),
    (new.id, 'Hobby',               '#3B82F6', 'gamecontroller.fill',      'spend',  22),
    (new.id, 'Transfer',            '#6366F1', 'tram.fill',                'spend',  23),
    (new.id, 'Income',              '#32D74B', 'dollarsign.circle.fill',   'income', 200);
  return new;
end $$;
