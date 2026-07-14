-- Quay 1 — broker logins + manager staff-add support
-- ============================================================
-- 1. Brokers are login-only accounts for the HubSpot marketing dashboard
--    (twigs002.github.io/quay-hubspot). They never clock in and carry no
--    payroll. quay-hubspot/auth.js gates access on staff.is_broker; its
--    recruitment candidate-matching keys off staff.email. Add both columns.
-- 2. Extend the admin write-guard so a plain admin (manager) cannot flip the
--    new is_broker elevation flag on other rows (defence in depth — the UI
--    already hides it from managers).
--
-- Managers ADDING the caller/support roles (RM, LN, Assistant, Admin
-- Assistant) is handled by the admin-create-staff Edge Function, which runs
-- as the service role and so bypasses RLS + this trigger. No INSERT policy
-- change is needed here.
-- ============================================================

-- 1. New columns -------------------------------------------------
alter table public.staff
  add column if not exists is_broker boolean not null default false;
alter table public.staff
  add column if not exists email text;

comment on column public.staff.is_broker is
  'Login-only broker account for the HubSpot marketing dashboard. No clock-in, no payroll. Gated in quay-hubspot/auth.js.';
comment on column public.staff.email is
  'Real work email (e.g. name@quay1.co.za). Used by quay-hubspot recruitment to match a broker to their candidates. NOT the synthetic <id>@quay1.local login address.';

create index if not exists staff_is_broker_idx on public.staff(is_broker) where is_broker;

-- 2. Tighten the admin write-guard -------------------------------
-- The existing guard (see 2026-07-01_staff_rls_split.sql) blocks non-supers
-- from changing is_super, is_admin, hourly_rate, weekly_hours and
-- designation. Add is_broker so a manager cannot self-promote or convert any
-- row into a broker login. Recreating the function is enough — the BEFORE
-- UPDATE trigger already points at it.
create or replace function public.staff_admin_write_guard()
returns trigger language plpgsql
security definer
set search_path = public
as $$
declare
  caller_super boolean := public.is_super_flag();
begin
  if not caller_super then
    if (new.is_super is distinct from old.is_super)
       or (new.is_admin is distinct from old.is_admin)
       or (new.is_broker is distinct from old.is_broker)
       or (new.hourly_rate is distinct from old.hourly_rate)
       or (new.weekly_hours is distinct from old.weekly_hours)
       or (new.designation is distinct from old.designation) then
      raise exception 'Only supers can change is_super, is_admin, is_broker, hourly_rate, weekly_hours or designation.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
