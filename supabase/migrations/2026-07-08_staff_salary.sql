-- Monthly salary (admin-only, alongside hourly_rate). Populated by admins via
-- the Team edit form; never exposed through the public staff projection.
alter table public.staff
  add column if not exists salary numeric;
