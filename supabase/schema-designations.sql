-- Quay 1 - role designations + LN/Assistant clock-out reports
-- ============================================================
-- Adds the six-tier designation system (super_admin, manager, rm,
-- fancy, ln, assistant) plus a clock_out_reports table for the
-- LN/Assistant end-of-day capture form. Run once in the Supabase
-- SQL Editor for the quay-clock project. Idempotent.
--
-- Designations sit ALONGSIDE the existing is_super / is_admin / is_manager
-- booleans rather than replacing them so existing access checks keep
-- working. The booleans remain the source of truth for access, the
-- designation column drives the LN/Assistant form gating + reporting.
-- ============================================================

-- 1) staff.designation -------------------------------------------------
alter table public.staff
  add column if not exists designation text;

-- 2) staff.division (free-form for now; picker on the frontend caps the
-- effective values to whatever is_admin / managers configure).
alter table public.staff
  add column if not exists division text;

-- 3) Seed designation from existing booleans so the table is never empty.
update public.staff set designation = 'super_admin'
  where designation is null and is_super = true;
update public.staff set designation = 'manager'
  where designation is null and is_admin = true and is_super = false;
update public.staff set designation = 'fancy'
  where designation is null;   -- safest default; admin can re-classify

-- 4) clock_out_reports - one row per LN/Assistant clock-out submission.
-- ALL numeric counts default to 0 so the form can default-fill.
create table if not exists public.clock_out_reports (
  id                       uuid primary key default gen_random_uuid(),
  staff_id                 text not null references public.staff(id) on delete cascade,
  designation              text not null,
  division                 text default '',
  clocked_out_at           timestamptz not null default now(),

  -- HubSpot work summary
  hs_tasks_completed       integer not null default 0,
  hs_calls_made            integer not null default 0,
  hs_emails_sent           integer not null default 0,
  hs_whatsapps_sent        integer not null default 0,
  hs_answered_contacts     integer not null default 0,
  hs_leads_vals            integer not null default 0,
  hs_reconverted_leads     integer not null default 0,

  -- DialFire canvassing
  df_calls                 integer not null default 0,
  df_email_successes       integer not null default 0,
  df_leads_vals            integer not null default 0,
  df_hours                 numeric(6,2) not null default 0,

  -- WhatsApp campaigns
  wa_sent                  integer not null default 0,
  wa_responses             integer not null default 0,
  wa_leads_vals            integer not null default 0,

  -- Free text
  notes                    text default '',

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists clock_out_reports_staff_idx
  on public.clock_out_reports(staff_id, clocked_out_at desc);
create index if not exists clock_out_reports_date_idx
  on public.clock_out_reports(clocked_out_at desc);

-- 5) updated_at trigger so we can rely on it for edit-window checks.
create or replace function public.touch_clock_out_reports_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists clock_out_reports_set_updated_at on public.clock_out_reports;
create trigger clock_out_reports_set_updated_at
  before update on public.clock_out_reports
  for each row execute function public.touch_clock_out_reports_updated_at();

-- 6) RLS - readable by anyone authenticated. Insertable + 24h-editable
-- by the submitter (or any admin). Deletes only by admin.
alter table public.clock_out_reports enable row level security;

drop policy if exists clock_out_reports_select_authn on public.clock_out_reports;
create policy clock_out_reports_select_authn on public.clock_out_reports
  for select to authenticated using (true);

drop policy if exists clock_out_reports_insert_self on public.clock_out_reports;
create policy clock_out_reports_insert_self on public.clock_out_reports
  for insert to authenticated
  with check (
    staff_id = (select id from public.staff where auth_user_id = auth.uid())
    or public.is_admin()
  );

drop policy if exists clock_out_reports_update_self on public.clock_out_reports;
create policy clock_out_reports_update_self on public.clock_out_reports
  for update to authenticated
  using (
    public.is_admin()
    or (
      staff_id = (select id from public.staff where auth_user_id = auth.uid())
      and clocked_out_at > now() - interval '24 hours'
    )
  )
  with check (
    public.is_admin()
    or staff_id = (select id from public.staff where auth_user_id = auth.uid())
  );

drop policy if exists clock_out_reports_delete_admin on public.clock_out_reports;
create policy clock_out_reports_delete_admin on public.clock_out_reports
  for delete to authenticated using (public.is_admin());

-- 7) Stream changes so the dashboard refreshes when a new report lands.
alter publication supabase_realtime add table public.clock_out_reports;
