-- Quay 1 — reserved can_manage_brokers column (future broker delegation)
-- ============================================================
-- The Brokers sub-view (dashboard v2 Staff tab) is gated on is_super, so it is
-- visible to superusers only (Alan is a plain admin, is_super=false, and is
-- already excluded). This column is a RESERVED hook for later delegating
-- broker management to a specific NON-super without granting full super — the
-- dashboard does not read it yet. Kept guard-protected so only supers can set
-- it. Defaults to false for everyone; harmless while unused.
-- ============================================================

-- 1. New column -------------------------------------------------
alter table public.staff
  add column if not exists can_manage_brokers boolean not null default false;

comment on column public.staff.can_manage_brokers is
  'RESERVED: future grant for delegating the Brokers sub-view to a non-super. Not read by the dashboard yet — Brokers is currently gated on is_super. Guard-protected: only supers may set it.';

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
