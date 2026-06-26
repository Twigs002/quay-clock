-- 2026-06-26  Hourly-rate history so historical timesheets keep the rate
--             that was in force on the shift date even after an increase.
--
-- Billing cycle: 21st of one month through the 20th of the next. A rate
-- change made after the 20th lands in the *next* cycle; the cycle that
-- ended on the 20th is locked.
--
-- Reads stay simple: callers ask `staff_rate_at(staff_id, shift_date)`
-- and get the rate in force on that date. `staff.hourly_rate` is kept as
-- a denormalised "current rate" cache so the existing payroll surface
-- and Team card don't break.

begin;

-- ── Schema ────────────────────────────────────────────────────────────
create table if not exists public.staff_rate_history (
  id              uuid        primary key default gen_random_uuid(),
  staff_id        text        not null references public.staff(id)
                                  on update cascade on delete cascade,
  hourly_rate     numeric(10,2) not null,
  effective_from  date        not null,
  reason          text        default '',
  changed_by      text        references public.staff(id) on update cascade,
  created_at      timestamptz not null default now(),
  unique (staff_id, effective_from)
);

-- Fast lookup for "rate at date X" → newest row with effective_from <= X.
create index if not exists staff_rate_history_lookup_idx
  on public.staff_rate_history (staff_id, effective_from desc);

-- ── Helper: which billing period does a date sit in? ───────────────────
-- Returns the END date of the billing period containing _on_date.
-- 1st–20th  → period ends on the 20th of the same month.
-- 21st–31st → period ends on the 20th of the next month.
create or replace function public.billing_period_end(_on_date date)
returns date language sql immutable as $$
  select case
    when extract(day from _on_date)::int <= 20
      then make_date(extract(year from _on_date)::int,
                     extract(month from _on_date)::int, 20)
    else (date_trunc('month', _on_date)::date
          + interval '1 month'
          + interval '19 days')::date
  end;
$$;

create or replace function public.billing_period_start(_on_date date)
returns date language sql immutable as $$
  -- The period that ends on billing_period_end(d) starts on the 21st of
  -- the previous month.
  select (public.billing_period_end(_on_date)
          - interval '1 month'
          + interval '1 day')::date;
$$;

-- ── Helper: rate effective on a given date ─────────────────────────────
-- Most-recent history row with effective_from <= _on_date.
create or replace function public.staff_rate_at(_staff_id text, _on_date date)
returns numeric language sql stable as $$
  select hourly_rate
    from public.staff_rate_history
   where staff_id = _staff_id
     and effective_from <= _on_date
   order by effective_from desc
   limit 1;
$$;

-- ── RLS ────────────────────────────────────────────────────────────────
alter table public.staff_rate_history enable row level security;

drop policy if exists "rate_history read"  on public.staff_rate_history;
drop policy if exists "rate_history write" on public.staff_rate_history;

-- Read: any authenticated user (mirrors public.staff). Payroll surfaces
-- on the dashboard need this.
create policy "rate_history read" on public.staff_rate_history
  for select to authenticated using (true);

-- Write: admins / super admins only (mirrors public.staff RLS).
create policy "rate_history write" on public.staff_rate_history
  for all to authenticated
  using (
    exists (
      select 1 from public.staff
      where auth_user_id = auth.uid()
        and (is_admin = true or is_super = true
             or designation in ('manager','super_admin'))
    )
  )
  with check (
    exists (
      select 1 from public.staff
      where auth_user_id = auth.uid()
        and (is_admin = true or is_super = true
             or designation in ('manager','super_admin'))
    )
  );

-- ── Backfill ───────────────────────────────────────────────────────────
-- Seed history from the current staff.hourly_rate. The July 2026 rates
-- (per 2026-06-24_july_payroll_rates.sql) were the prevailing rates from
-- the start of the July billing period, so we anchor effective_from to
-- the start of the July cycle (Jun 21, 2026).
insert into public.staff_rate_history (staff_id, hourly_rate, effective_from, reason)
select id, hourly_rate, date '2026-06-21', 'Initial seed from staff.hourly_rate'
  from public.staff
 where hourly_rate is not null
on conflict (staff_id, effective_from) do nothing;

-- ── Sync helper: writing a new rate ────────────────────────────────────
-- Inserts a history row + updates the denormalised staff.hourly_rate so
-- existing consumers stay correct without doing a join. Idempotent on
-- (staff_id, effective_from): re-running with the same effective_from
-- bumps the rate in place.
create or replace function public.staff_set_rate(
  _staff_id text,
  _new_rate numeric,
  _effective_from date default current_date,
  _reason text default ''
) returns void language plpgsql security definer
set search_path = public as $$
declare
  _self_id text;
begin
  -- Resolve the caller's staff_id for the audit trail. NULL if anon /
  -- service-role; we accept that because RLS still gates the write.
  select id into _self_id from public.staff
   where auth_user_id = auth.uid() limit 1;

  insert into public.staff_rate_history
    (staff_id, hourly_rate, effective_from, reason, changed_by)
    values
    (_staff_id, _new_rate, _effective_from, coalesce(_reason, ''), _self_id)
  on conflict (staff_id, effective_from) do update
    set hourly_rate = excluded.hourly_rate,
        reason      = excluded.reason,
        changed_by  = excluded.changed_by;

  -- Update the denormalised current rate only if the new effective_from
  -- is the latest one we know about (otherwise we'd clobber the current
  -- rate with a backfilled historical rate).
  update public.staff
     set hourly_rate = _new_rate
   where id = _staff_id
     and (
       select effective_from from public.staff_rate_history
        where staff_id = _staff_id
        order by effective_from desc limit 1
     ) = _effective_from;
end;
$$;

commit;
