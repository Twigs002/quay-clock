-- Quay 1 — payroll + shift-correction schema add-on
-- ============================================================
-- Run once in the Supabase SQL Editor. Idempotent.
--   - staff.hourly_rate   ZAR/hour for pro-rata pay
--   - staff.weekly_hours  expected/contracted hours per week
--   - requests.proposed_start  time the shift should have started
--   - requests.proposed_end    time the shift should have ended
-- ============================================================

alter table public.staff
  add column if not exists hourly_rate  numeric(10, 2),
  add column if not exists weekly_hours numeric(5, 2);

alter table public.requests
  add column if not exists proposed_start time,
  add column if not exists proposed_end   time;

-- Backfill a sensible weekly_hours default for existing rows.
update public.staff set weekly_hours = 40 where weekly_hours is null;
