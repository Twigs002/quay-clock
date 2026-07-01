-- Quay Clock — auto-clock-out overnight-shift guard
-- =================================================================
-- Audit finding A1 (P0): the original auto_clock_out_forgotten() only
-- inspected yesterday's events. A staffer who clocked in Mon 16:30 and
-- legitimately worked through the night to Tue 02:00 would be closed
-- at Mon 17:00 by the cron — wiping ~9 hours of real work.
--
-- Fix: require that yesterday's last "in" has NO clock activity BETWEEN
-- 17:00 SAST yesterday and NOW (which is 05:05 SAST today). If any
-- event landed in that window — including a real clock-out — the
-- staffer either finished normally or is still working; either way the
-- cron leaves them alone.
--
-- Also tighten the function to `revoke execute from anon, authenticated`
-- so only the postgres role (which pg_cron runs as) can invoke it —
-- pairs with audit finding A4 (P2).

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
    ),
    -- A1 guard: pull the last event AT OR AFTER 5pm SAST for each staffer,
    -- looking from 17:00 target-day through NOW. If there is one, the
    -- staffer either finished normally (out) or is still legitimately on
    -- an ongoing shift (in) — either way, do not synth-close them.
    activity_after_5pm as (
      select distinct on (e.staff_id)
        e.staff_id, e.ts, e.dir
      from public.events e
      where e.ts >= five_pm
        and e.ts <= now()
      order by e.staff_id, e.ts desc
    )
    select
      le.staff_id, le.ts as in_ts
    from last_events le
    join public.staff s on s.id = le.staff_id
    left join activity_after_5pm a on a.staff_id = le.staff_id
    where le.dir = 'in'
      and coalesce(s.active, true) = true
      and coalesce(s.designation, '') not in ('super_admin', 'manager')
      and le.ts < five_pm
      and a.staff_id is null  -- <-- A1 guard: no activity after 17:00
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
  'Closes out forgot-to-clock-out shifts by inserting a synthetic 17:00 SAST "out" event. Runs nightly via pg_cron. Guards against overnight shifts by requiring no clock activity between 17:00 SAST and the run time. Pass a specific date to backfill or dry_run=true to preview without inserting.';

-- A4 (P2): tighten execution surface. pg_cron runs as postgres, so
-- revoking from public/anon/authenticated leaves the scheduler untouched
-- but blocks any browser-side call via PostgREST.
revoke execute on function public.auto_clock_out_forgotten(date, boolean) from public;
revoke execute on function public.auto_clock_out_forgotten(date, boolean) from anon;
revoke execute on function public.auto_clock_out_forgotten(date, boolean) from authenticated;
