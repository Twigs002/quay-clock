-- Quay 1 — let managers reassign designation within the caller/support roles
-- ============================================================
-- Managers (is_admin, not is_super) previously could not change ANY protected
-- column, including `designation`, so a manager editing a staffer on the
-- dashboard hit "Only supers can change ... or designation." and the WHOLE
-- UPDATE was rejected (even a plain name change failed, because the client
-- echoed the unchanged designation back in the patch).
--
-- This relaxes ONLY the designation rule: a non-super may now change a staff
-- member's designation, but STRICTLY within the caller/support roles
-- (rm, fancy, ln, assistant, admin_assistant) and only for staff already in
-- one of those roles. This mirrors the dashboard's MGR_DESIG picker.
--
-- Still forbidden for a non-super (unchanged):
--   * super_admin / manager   — would grant admin / superuser access
--   * broker / senior_broker   — broker login accounts
--   * payroll                  — privileged dashboard access
--   * is_super, is_admin, is_broker, can_manage_brokers, is_senior_broker,
--     allowed_sites, hourly_rate, weekly_hours — all remain super-only
--
-- SAFETY: designation does NOT drive access — is_admin / is_super are the
-- independent source of truth for privilege (see schema-designations.sql), and
-- this guard still blocks any change to them. A manager therefore CANNOT set
-- anyone as an admin or superuser: the elevation columns stay locked, and the
-- target designation is capped to non-privileged caller/support roles (all of
-- which map to dashboard-only app access, so allowed_sites need not change).
--
-- Idempotent: recreates the guard function the existing BEFORE UPDATE trigger
-- (staff_admin_write_guard_tg) already points at — no trigger change needed.
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
    -- Elevation / pay / broker / access columns stay strictly super-only.
    if (new.is_super is distinct from old.is_super)
       or (new.is_admin is distinct from old.is_admin)
       or (new.is_broker is distinct from old.is_broker)
       or (new.can_manage_brokers is distinct from old.can_manage_brokers)
       or (new.is_senior_broker is distinct from old.is_senior_broker)
       or (new.allowed_sites is distinct from old.allowed_sites)
       or (new.hourly_rate is distinct from old.hourly_rate)
       or (new.weekly_hours is distinct from old.weekly_hours) then
      raise exception 'Only supers can change is_super, is_admin, is_broker, can_manage_brokers, is_senior_broker, allowed_sites, hourly_rate or weekly_hours.'
        using errcode = '42501';
    end if;
    -- Designation MAY be changed by a manager, but only among the caller/support
    -- roles, and only for staff already in one of those roles. This blocks
    -- promoting anyone to manager/super_admin (admin/superuser) and blocks
    -- touching broker / senior_broker / payroll records. coalesce() keeps the
    -- comparison deterministic for any legacy NULL designations (treated as
    -- outside the set, so a manager cannot reclassify them).
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
