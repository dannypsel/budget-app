-- ============================================================
-- SIMPLIFI TRANSACTION EXTRAS (see docs/simplifi-rea-findings.md)
--   transactions.original_description  Plaid-owned raw statement text
--                                      (Simplifi's "statement name"); the sync
--                                      requests include_original_description.
--   transactions.user_flag / _note     user-owned color flag, Simplifi's
--                                      RED..BROWN palette (NULL = no flag).
--   categories.exclude_from_reports    Simplifi's category-level exclusion.
--   transaction_attachments + private  receipts/files per transaction, stored
--   storage bucket "attachments"       under <auth.uid()>/<txn id>/<file>.
--   Fresh-DB safe (IF NOT EXISTS). Apply BEFORE deploying the sync service:
--   the sync writes original_description.
-- ============================================================

alter table transactions
  add column if not exists original_description text,
  add column if not exists user_flag text,
  add column if not exists user_flag_note text;

do $$ begin
  alter table transactions add constraint transactions_user_flag_check
    check (user_flag is null or user_flag in
      ('RED','ORANGE','YELLOW','GREEN','BLUE','VIOLET','BLACK','BROWN'));
exception when duplicate_object then null; end $$;

alter table categories
  add column if not exists exclude_from_reports boolean not null default false;

create table if not exists transaction_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  content_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists idx_txn_attachments_txn on transaction_attachments(transaction_id);
create index if not exists idx_txn_attachments_user on transaction_attachments(user_id);

alter table transaction_attachments enable row level security;
drop policy if exists "own" on transaction_attachments;
create policy "own" on transaction_attachments for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on transaction_attachments to authenticated;
grant all on transaction_attachments to service_role;

-- Private bucket: never public; objects readable only by their owner through
-- signed URLs / authenticated requests. 10 MB cap per file.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "attachments own read" on storage.objects;
create policy "attachments own read" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachments own insert" on storage.objects;
create policy "attachments own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachments own delete" on storage.objects;
create policy "attachments own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
