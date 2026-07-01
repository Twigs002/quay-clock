-- Quay Clock — split staff table access so payroll data isn't world-readable
-- =================================================================
-- Audit finding C1 (P0): `staff` had `staff_select_authn using(true)`,
-- meaning any authenticated user (including LN/Assistants) could
-- `select hourly_rate, weekly_hours from staff` via devtools even though
-- the Payroll tab is client-gated.
--
-- Fix approach:
--   1. New `staff_public` view exposing SAFE columns (id, name, role,
--      team, designation, division, active, is_admin, is_super, plus
--      auth_user_id for row-key lookups) — readable to any authenticated
--      user.
--   2. Tighten `staff` SELECT policy to (a) self (id = current_staff_id())
--      OR (b) is_admin() OR is_super_flag(). Users can still see their
--      OWN rate + weekly_hours (needed by /me), admins can see all rows.
--      Non-admins CANNOT read anyone else's sensitive columns.
--   3. `staff_rate_history` — restrict SELECT to admin/super only.
--
-- Also applies audit finding C5 (P1): the existing `staff_admin_write`
-- policy let any admin update any column, including `is_super`. Add a
-- guard so only supers can flip is_super/is_admin/hourly_rate on other
-- staff — managers get scoped write via a trigger.

-- Helper: is caller a super?
create or replace function public.is_super_flag()
returns boolean language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select is_super from public.staff where auth_user_id = auth.uid()),
    false
  );
$$;

-- 1) SAFE VIEW ------------------------------------------------------
create or replace view public.staff_public as
select
  id, auth_user_id, name, role, team, active,
  designation, division, is_admin, is_super, created_at
from public.staff;

-- Views inherit RLS from base tables in Postgres — but we want the view
-- to be readable to authenticated regardless of staff's RLS. Use
-- `security_invoker=false` (default) so the view runs as its owner
-- (which has full access to the base table).
alter view public.staff_public set (security_invoker = off);

grant select on public.staff_public to authenticated;

comment on view public.staff_public is
  'Safe projection of public.staff for non-admin consumers. Excludes hourly_rate and weekly_hours (kept behind the base table RLS). Use this from LN name lookups, team pickers, and any surface that only needs identity + role, not pay data.';

-- 2) TIGHTEN staff SELECT ------------------------------------------
-- Drop the old blanket policy, replace with self-or-admin.
drop policy if exists staff_select_authn on public.staff;

create policy staff_select_self_or_admin
  on public.staff for select to authenticated
  using (
    id = public.current_staff_id()
    or public.is_admin()
    or public.is_super_flag()
  );

-- 3) staff_rate_history — admin/super only (already sensitive) --------
alter table public.staff_rate_history enable row level security;

drop policy if exists staff_rate_history_select on public.staff_rate_history;
create policy staff_rate_history_select
  on public.staff_rate_history for select to authenticated
  using (public.is_admin() or public.is_super_flag());

drop policy if exists staff_rate_history_write on public.staff_rate_history;
create policy staff_rate_history_write
  on public.staff_rate_history for all to authenticated
  using (public.is_admin() or public.is_super_flag())
  with check (public.is_admin() or public.is_super_flag());

-- 4) C5 — admin write scope guard --------------------------------
-- The existing `staff_admin_write` policy grants a manager full row
-- update rights, so a plain admin could `update staff set is_super=true
-- where id='self'` and self-promote. Trigger blocks non-supers from
-- editing the elevation columns.
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
       or (new.hourly_rate is distinct from old.hourly_rate)
       or (new.weekly_hours is distinct from old.weekly_hours)
       or (new.designation is distinct from old.designation) then
      raise exception 'Only supers can change is_super, is_admin, hourly_rate, weekly_hours or designation.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists staff_admin_write_guard_tg on public.staff;
create trigger staff_admin_write_guard_tg
  before update on public.staff
  for each row execute function public.staff_admin_write_guard();
