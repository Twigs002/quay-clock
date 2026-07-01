-- Quay Clock — auto-close forgotten clock-outs
-- =================================================================
-- If a staffer clocks in during the day but forgets to clock out,
-- insert a synthetic "out" event at 17:00 SAST on the day they clocked
-- in. Runs every morning at 05:05 SAST via pg_cron. The note pattern
-- ("Auto clock-out … forgot to clock out") matches what quay-dashboard-v2
-- already scans for, so the ⚠️ "Forgot to clock out" badge + Red Flags
-- panel light up automatically — nothing to change on the dashboard.
--
-- Exemptions (matches dashboard's isExemptStaff logic):
--   - staff.active = false             → skip
--   - designation in (super_admin,     → skip
--                     manager)
--   - clock-in already after 17:00     → skip (evening shift, admin
--                                         handles manually)
--
-- Idempotent: once we insert an "out", the staffer's last event that
-- day flips from "in" to "out", so the next run is a no-op.

-- 1) The worker function --------------------------------------------
create or replace function public.auto_clock_out_forgotten(
  for_day date default null,
  dry_run boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_day  date;
  day_start   timestamptz;
  day_end     timestamptz;
  five_pm     timestamptz;
  inserted    integer := 0;
  r           record;
  note_text   text := 'Auto clock-out: forgot to clock out — 5pm applied by system';
begin
  target_day := coalesce(
    for_day,
    ((now() at time zone 'Africa/Johannesburg')::date - 1)
  );
  day_start := (target_day || ' 00:00:00')::timestamp at time zone 'Africa/Johannesburg';
  day_end   := (target_day || ' 23:59:59.999')::timestamp at time zone 'Africa/Johannesburg';
  five_pm   := (target_day || ' 17:00:00')::timestamp at time zone 'Africa/Johannesburg';

  for r in
    with last_events as (
      select distinct on (e.staff_id)
        e.staff_id, e.id, e.ts, e.dir
      from public.events e
      where e.ts >= day_start and e.ts <= day_end
      order by e.staff_id, e.ts desc
    )
    select
      le.staff_id, le.ts as in_ts
    from last_events le
    join public.staff s on s.id = le.staff_id
    where le.dir = 'in'
      and coalesce(s.active, true) = true
      and coalesce(s.designation, '') not in ('super_admin', 'manager')
      and le.ts < five_pm
  loop
    inserted := inserted + 1;
    if dry_run then continue; end if;

    insert into public.events (staff_id, ts, dir, note, location, duration_hrs)
    values (
      r.staff_id,
      five_pm,
      'out',
      note_text,
      'system',
      round(extract(epoch from (five_pm - r.in_ts))::numeric / 3600.0, 4)
    );
  end loop;

  return inserted;
end;
$$;

comment on function public.auto_clock_out_forgotten(date, boolean) is
  'Closes out forgot-to-clock-out shifts by inserting a synthetic 17:00 SAST "out" event. Runs nightly via pg_cron. Pass a specific date to backfill or dry_run=true to preview without inserting.';

-- 2) pg_cron schedule ------------------------------------------------
-- Requires the pg_cron extension. On Supabase this is available in the
-- "extensions" schema — enable via the Dashboard if not already on.
create extension if not exists pg_cron with schema extensions;

-- Drop any prior schedule so re-running this migration is idempotent.
select cron.unschedule('auto-clock-out-forgotten')
  where exists (
    select 1 from cron.job where jobname = 'auto-clock-out-forgotten'
  );

-- 05:05 SAST = 03:05 UTC (SAST is UTC+2, no DST)
select cron.schedule(
  'auto-clock-out-forgotten',
  '5 3 * * *',
  $$select public.auto_clock_out_forgotten();$$
);
