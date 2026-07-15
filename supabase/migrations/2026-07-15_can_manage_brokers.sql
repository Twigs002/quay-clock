-- Quay 1 — split Brokers management out of the superuser grant
-- ============================================================
-- The Brokers sub-view (dashboard v2 Staff tab) was gated on is_super, so
-- every superuser saw it. We want a superuser (e.g. Alan) to keep Staff /
-- Leadership / Teams / Payroll but NOT see Brokers. Add a dedicated
-- can_manage_brokers grant that the dashboard gates the Brokers view on.
--
-- Defaults to false for everyone — no one sees Brokers until explicitly
-- granted. Grant it to whoever should manage broker logins (see step 3).
-- ============================================================

-- 1. New column -------------------------------------------------
alter table public.staff
  add column if not exists can_manage_brokers boolean not null default false;

comment on column public.staff.can_manage_brokers is
  'Grants access to the Brokers sub-view on the dashboard Staff tab (add/edit broker logins). Separate from is_super: a superuser without this flag sees Staff but not Brokers.';

-- 2. Tighten the admin write-guard -------------------------------
-- Add can_manage_brokers to the set of protected columns only supers may
-- change, so a manager cannot self-grant broker management. Recreating the
-- function is enough — the BEFORE UPDATE trigger already points at it.
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
       or (new.can_manage_brokers is distinct from old.can_manage_brokers)
       or (new.hourly_rate is distinct from old.hourly_rate)
       or (new.weekly_hours is distinct from old.weekly_hours)
       or (new.designation is distinct from old.designation) then
      raise exception 'Only supers can change is_super, is_admin, is_broker, can_manage_brokers, hourly_rate, weekly_hours or designation.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- 3. Grant to the broker admin(s) --------------------------------
-- Uncomment and set the staff id(s) that should manage brokers. Leaving this
-- commented means NO ONE sees the Brokers view until granted.
--   update public.staff set can_manage_brokers = true where id = '<owner-id>';
