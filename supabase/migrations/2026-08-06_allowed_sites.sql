-- Quay 1 — per-person app access (allowed_sites)
-- ============================================================
-- Adds an explicit, per-staff list of which Quay 1 apps ("sites") a person may
-- reach: the app switcher (quay-nav.js) shows only these to a non-super, and
-- each app can gate its own login on membership.
--
-- Site ids match quay-nav.js SITES:
--   'dashboard' · 'leads' · 'hubspot' · 'boarding' · 'polar'
--
-- DELIBERATELY INDEPENDENT of is_broker / designation / payroll. Granting a
-- broker (or anyone) Polar Push must NOT change their pay treatment, so site
-- access lives on its own column. Superusers implicitly see every site
-- regardless of this list; it only ever *grants* to non-supers, never restricts
-- a super. Empty (the default) means "no extra apps" — behaviour is unchanged
-- for the 100+ existing staff until a super explicitly grants a site.
-- ============================================================

-- 1. New column -------------------------------------------------
alter table public.staff
  add column if not exists allowed_sites text[] not null default '{}';

comment on column public.staff.allowed_sites is
  'Per-person list of Quay 1 app ids this staff member may access (matches quay-nav.js SITES: dashboard, leads, hubspot, boarding, polar). Independent of is_broker/payroll. Supers see all sites regardless. Guard-protected: only supers may change it.';

-- 2. Tighten the admin write-guard -------------------------------
-- Add allowed_sites to the set of protected columns only supers may change, so
-- a manager cannot self-grant app access. Recreating the function is enough —
-- the BEFORE UPDATE trigger already points at it.
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
       or (new.is_senior_broker is distinct from old.is_senior_broker)
       or (new.allowed_sites is distinct from old.allowed_sites)
       or (new.hourly_rate is distinct from old.hourly_rate)
       or (new.weekly_hours is distinct from old.weekly_hours)
       or (new.designation is distinct from old.designation) then
      raise exception 'Only supers can change is_super, is_admin, is_broker, can_manage_brokers, is_senior_broker, allowed_sites, hourly_rate, weekly_hours or designation.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
