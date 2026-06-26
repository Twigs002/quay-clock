-- 2026-06-26  Hourly-rate history so historical timesheets keep the rate
--             that was in force on the shift date even after an increase.
--
-- Billing cycle: 21st of one month through the 20th of the next. A rate
-- change made after the 20th lands in the *next* cycle; the cycle that
-- ended on the 20th is locked.
--
-- Two transactions:
--   1. Schema + RLS + read helpers — safe, no data writes.
--   2. Backfill — seeds existing staff.hourly_rate into history with
--      effective_from = 2026-06-21 (start of the July cycle).
--
-- Run them in order. You can pause between them to verify the empty
-- table looks right before seeding it.

-- ════════════════════════════════════════════════════════════════════════
-- TRANSACTION 1 — schema, helpers, RLS (no data changes)
-- ════════════════════════════════════════════════════════════════════════
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

-- ── Billing-period helpers (21st → 20th cycle) ────────────────────────
-- Pure functions; no privileged access, no DML. Safe.
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

-- ── Resolve the rate effective on a given date ────────────────────────
-- Read-only. STABLE (not SECURITY DEFINER). Honours the caller's RLS.
create or replace function public.staff_rate_at(_staff_id text, _on_date date)
returns numeric language sql stable as $$
  select hourly_rate
    from public.staff_rate_history
   where staff_id = _staff_id
     and effective_from <= _on_date
   order by effective_from desc
   limit 1;
$$;

-- ── RLS — reuse the existing public.is_admin() helper for consistency ─
-- Mirrors the staff_admin_write / events_admin_write pattern already in
-- schema.sql. Reads open to all authenticated (matches public.staff);
-- writes gated to admins only.
alter table public.staff_rate_history enable row level security;

drop policy if exists "rate_history read"  on public.staff_rate_history;
drop policy if exists "rate_history write" on public.staff_rate_history;

create policy "rate_history read" on public.staff_rate_history
  for select to authenticated using (true);

create policy "rate_history write" on public.staff_rate_history
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

commit;

-- ════════════════════════════════════════════════════════════════════════
-- TRANSACTION 2 — backfill (writes one row per staff with a rate set)
-- ════════════════════════════════════════════════════════════════════════
-- Verify TXN 1 landed first:
--   select count(*) from public.staff_rate_history;        -- should be 0
--   select staff_rate_at('whitney-malgas', current_date);  -- should be null
-- Then run this:
begin;

insert into public.staff_rate_history (staff_id, hourly_rate, effective_from, reason)
select id, hourly_rate, date '2026-06-21', 'Initial seed from staff.hourly_rate'
  from public.staff
 where hourly_rate is not null
on conflict (staff_id, effective_from) do nothing;

commit;

-- Verify the backfill:
--   select count(*) from public.staff_rate_history;        -- ~39 rows
--   select staff_rate_at('whitney-malgas', current_date);  -- 46.51
