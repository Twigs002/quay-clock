-- Add "Commercial" as a canonical payroll division / team.
--
-- Commercial is now a clock-in/out option for staff (see CLOCK_CAMPAIGNS_ALL
-- in app.js). The admin timesheet team picker allocates payroll hours by the
-- rows in payroll_canonical_divisions, so add Commercial here too to keep the
-- picker and payroll allocation in sync.
--
-- Idempotent: safe to re-run.
insert into public.payroll_canonical_divisions (name)
select 'Commercial'
where not exists (
  select 1 from public.payroll_canonical_divisions where name = 'Commercial'
);
