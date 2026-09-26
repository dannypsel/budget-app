-- Default household display name for the greeting.
--
-- The dashboard greeting addresses the household ("Good morning, Dara.").
-- New signups still get whatever first_name they enter at signup; this only
-- supplies the household default when no name was given. Existing profiles are
-- untouched. Fresh-DB safe; trigger is security definer (unchanged).

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, first_name, last_name)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'first_name', ''), 'Dara'),
          nullif(new.raw_user_meta_data->>'last_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
