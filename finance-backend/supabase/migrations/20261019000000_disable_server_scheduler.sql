-- Lambda rebuild (2026-09-26): the server-side scheduler is gone. Refresh is
-- manual — the user taps refresh in the app, which calls POST /sync/trigger on
-- the Lambda Function URL. Unschedule the pocketlens-* pg_cron jobs created by
-- 20260919000000_server_side_scheduler.sql.
--
-- Defensive: cron.unschedule errors on a job that doesn't exist, so only
-- unschedule jobs actually present in cron.job. Covers fresh databases where
-- the Vault secrets were never set (jobs were created by cron.schedule anyway
-- at migration time, but belt-and-braces costs nothing) and re-runs.

do $$
declare
  j text;
begin
  for j in
    select jobname
    from cron.job
    where jobname in ('pocketlens-wake-api',
                      'pocketlens-hourly-sync',
                      'pocketlens-daily',
                      'pocketlens-keep-awake')
  loop
    perform cron.unschedule(j);
    raise notice 'unscheduled pg_cron job: %', j;
  end loop;
end
$$;
