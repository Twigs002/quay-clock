-- South African public holidays reference table.
--
-- Any Quay 1 payroll / timesheet aggregation must treat a public holiday
-- day as unpaid (zero paid hours) regardless of whether staff clocked in.
-- Same rule as absence and sick per user policy 2026-07-06:
--   absence + sick + public holiday = all zero paid hours
--
-- Rows carry both the statutory date and the observed date. Public
-- Holidays Act 36 of 1994 s2(1): "Whenever any public holiday falls on
-- a Sunday, the Monday following on it shall be a public holiday." The
-- observed_date is what payroll actually compares against for zeroing.

create table if not exists public.sa_public_holidays (
  date          date primary key,
  name          text not null,
  observed_date date not null,
  notes         text
);

-- Read policy: anyone authenticated can select (the dashboard reads
-- this on every payroll render). No writes from the client - seeded
-- from migrations and updated once a year for the next year's dates.
alter table public.sa_public_holidays enable row level security;

drop policy if exists sa_public_holidays_select_authn on public.sa_public_holidays;
create policy sa_public_holidays_select_authn on public.sa_public_holidays
  for select to authenticated using (true);

-- Seed 2024 through 2027. Sunday-observed adjustments applied.
insert into public.sa_public_holidays (date, name, observed_date) values
  -- 2024
  ('2024-01-01', 'New Year''s Day',              '2024-01-01'),
  ('2024-03-21', 'Human Rights Day',              '2024-03-21'),
  ('2024-03-29', 'Good Friday',                   '2024-03-29'),
  ('2024-04-01', 'Family Day',                    '2024-04-01'),
  ('2024-04-27', 'Freedom Day',                   '2024-04-27'),
  ('2024-05-01', 'Workers'' Day',                 '2024-05-01'),
  ('2024-05-29', 'National Elections Day',        '2024-05-29'),
  ('2024-06-16', 'Youth Day',                     '2024-06-17'),   -- Sun to Mon
  ('2024-08-09', 'National Women''s Day',         '2024-08-09'),
  ('2024-09-24', 'Heritage Day',                  '2024-09-24'),
  ('2024-12-16', 'Day of Reconciliation',         '2024-12-16'),
  ('2024-12-25', 'Christmas Day',                 '2024-12-25'),
  ('2024-12-26', 'Day of Goodwill',               '2024-12-26'),
  -- 2025
  ('2025-01-01', 'New Year''s Day',              '2025-01-01'),
  ('2025-03-21', 'Human Rights Day',              '2025-03-21'),
  ('2025-04-18', 'Good Friday',                   '2025-04-18'),
  ('2025-04-21', 'Family Day',                    '2025-04-21'),
  ('2025-04-27', 'Freedom Day',                   '2025-04-28'),   -- Sun to Mon
  ('2025-05-01', 'Workers'' Day',                 '2025-05-01'),
  ('2025-06-16', 'Youth Day',                     '2025-06-16'),
  ('2025-08-09', 'National Women''s Day',         '2025-08-09'),
  ('2025-09-24', 'Heritage Day',                  '2025-09-24'),
  ('2025-12-16', 'Day of Reconciliation',         '2025-12-16'),
  ('2025-12-25', 'Christmas Day',                 '2025-12-25'),
  ('2025-12-26', 'Day of Goodwill',               '2025-12-26'),
  -- 2026
  ('2026-01-01', 'New Year''s Day',              '2026-01-01'),
  ('2026-03-21', 'Human Rights Day',              '2026-03-21'),
  ('2026-04-03', 'Good Friday',                   '2026-04-03'),
  ('2026-04-06', 'Family Day',                    '2026-04-06'),
  ('2026-04-27', 'Freedom Day',                   '2026-04-27'),
  ('2026-05-01', 'Workers'' Day',                 '2026-05-01'),
  ('2026-06-16', 'Youth Day',                     '2026-06-16'),
  ('2026-08-09', 'National Women''s Day',         '2026-08-10'),   -- Sun to Mon
  ('2026-09-24', 'Heritage Day',                  '2026-09-24'),
  ('2026-12-16', 'Day of Reconciliation',         '2026-12-16'),
  ('2026-12-25', 'Christmas Day',                 '2026-12-25'),
  ('2026-12-26', 'Day of Goodwill',               '2026-12-26'),
  -- 2027
  ('2027-01-01', 'New Year''s Day',              '2027-01-01'),
  ('2027-03-21', 'Human Rights Day',              '2027-03-22'),   -- Sun to Mon
  ('2027-03-26', 'Good Friday',                   '2027-03-26'),
  ('2027-03-29', 'Family Day',                    '2027-03-29'),
  ('2027-04-27', 'Freedom Day',                   '2027-04-27'),
  ('2027-05-01', 'Workers'' Day',                 '2027-05-01'),
  ('2027-06-16', 'Youth Day',                     '2027-06-16'),
  ('2027-08-09', 'National Women''s Day',         '2027-08-09'),
  ('2027-09-24', 'Heritage Day',                  '2027-09-24'),
  ('2027-12-16', 'Day of Reconciliation',         '2027-12-16'),
  ('2027-12-25', 'Christmas Day',                 '2027-12-25'),
  ('2027-12-26', 'Day of Goodwill',               '2027-12-27')    -- Sun to Mon
on conflict (date) do nothing;
