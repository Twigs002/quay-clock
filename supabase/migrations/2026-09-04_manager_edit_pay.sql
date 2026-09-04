-- Quay 1 - let managers edit pay (hourly rate, weekly hours, salary)
-- ============================================================
-- Managers (is_admin, not is_super) previously could not change hourly_rate or
-- weekly_hours: the staff write guard reserved them to supers, so a manager
-- saving a pay edit on the dashboard hit
--   "Only supers can change ... hourly_rate or weekly_hours."
-- and the WHOLE update was rejected.
--
-- This relaxes the guard so a non-super MAY change the pay columns:
--   hourly_rate, weekly_hours   - now allowed for managers (removed from guard)
--   salary, salary_type         - already unguarded, no change needed
--
-- Still reserved to supers (unchanged):
--   is_super, is_admin, is_broker, can_manage_brokers, is_senior_broker,
--   allowed_sites
--
-- The designation rule is unchanged: a non-super may still only move a staffer
-- between the caller/support roles (rm, fancy, ln, assistant, admin_assistant),
-- and only for staff already in one of those roles.
--
-- SAFETY: pay is not a privilege. is_admin / is_super remain the source of truth
-- for access and stay locked, so a manager still cannot promote anyone or widen
-- app access - this only lets them set what a person is paid.
--
-- REVERSIBLE: to restore super-only pay, re-run the previous migration
-- 2026-08-25_manager_designation.sql (it recreates this same function with
-- hourly_rate and weekly_hours back in the reserved list).
--
-- Idempotent: recreates the guard function the existing BEFORE UPDATE trigger
-- (staff_admin_write_guard_tg) already points at - no trigger change needed.
-- Run once in the Supabase SQL Editor for the quay-clock project.
-- ============================================================

create or replace function public.staff_admin_write_guard()
returns trigger language plpgsql
security definer
set search_path = public
as $$
declare
  caller_super boolean := public.is_super_flag();
  -- Roles a manager may assign. Matches the dashboard MGR_DESIG picker.
  mgr_desigs constant text[] := array['rm','fancy','ln','assistant','admin_assistant'];
begin
  if not caller_super then
    -- Elevation / broker / access columns stay strictly super-only. The pay
    -- columns (hourly_rate, weekly_hours, salary, salary_type) are deliberately
    -- NOT listed here, so a manager may change them.
    if (new.is_super is distinct from old.is_super)
       or (new.is_admin is distinct from old.is_admin)
       or (new.is_broker is distinct from old.is_broker)
       or (new.can_manage_brokers is distinct from old.can_manage_brokers)
       or (new.is_senior_broker is distinct from old.is_senior_broker)
       or (new.allowed_sites is distinct from old.allowed_sites) then
      raise exception 'Only supers can change is_super, is_admin, is_broker, can_manage_brokers, is_senior_broker or allowed_sites.'
        using errcode = '42501';
    end if;
    -- Designation MAY be changed by a manager, but only among the caller/support
    -- roles, and only for staff already in one of those roles. This blocks
    -- promoting anyone to manager/super_admin and blocks touching broker /
    -- senior_broker / payroll records. coalesce() keeps the comparison
    -- deterministic for any legacy NULL designations (treated as outside the
    -- set, so a manager cannot reclassify them).
    if (new.designation is distinct from old.designation)
       and not (coalesce(old.designation, '') = any(mgr_desigs)
                and coalesce(new.designation, '') = any(mgr_desigs)) then
      raise exception 'Managers may only set a designation of rm, fancy, ln, assistant or admin_assistant, and only for staff already in one of those roles. Changing to/from manager, super_admin, broker, senior_broker or payroll is superuser-only.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- The BEFORE UPDATE trigger staff_admin_write_guard_tg already executes this
-- function, so replacing it above is sufficient. Re-assert it defensively in
-- case this migration is run against a database where the trigger was dropped.
drop trigger if exists staff_admin_write_guard_tg on public.staff;
create trigger staff_admin_write_guard_tg
  before update on public.staff
  for each row execute function public.staff_admin_write_guard();
