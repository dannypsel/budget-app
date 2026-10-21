-- Simplifi keeps two per-transaction switches: "Exclude from spending plan"
-- (isExcludedFromF2S) and "Exclude from reports" (isExcludedFromReports).
-- exclude_from_totals stays the spending-plan switch (budgets, category_spend,
-- dashboard totals); this adds the reports one (Reports + the Transactions
-- analysis tabs). Backfilled from exclude_from_totals so nothing that's out of
-- reports today comes back. Linked transfer legs are skipped: reports drop them
-- by transfer_group_id, and unlinking must bring them back.
alter table transactions add column if not exists exclude_from_reports boolean not null default false;

update transactions set exclude_from_reports = true
where exclude_from_totals and transfer_group_id is null and not exclude_from_reports;
