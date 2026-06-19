-- ============================================================
-- Quay 1 — clock_out_reports privacy gate (manager-only access)
-- ============================================================
-- Twin of rls_events_privacy.sql and rls_requests_privacy.sql for the
-- end-of-day report submissions.
--
-- Previously public.clock_out_reports had a single permissive read
-- policy (clock_out_reports_select_authn: USING true) which let any
-- authenticated staffer read every other staffer's EoD submission
-- (HubSpot tasks/calls/emails counts + DialFire stats + WhatsApp
-- numbers + the free-text notes field). The dashboard's All Staff →
-- LN & Assistants sub-tab is the intended consumer; access to that
-- view is admin-only at the UI layer, but the database itself was
-- handing the rows to anyone with a session token.
--
-- Now:
--   - Staff see only reports where staff_id = their own staff record
--     (resolved via public.current_staff_id() — the same helper used
--     by the events and requests policies).
--   - Admins (public.is_admin() = true) keep cross-staff read access
--     for the dashboard's manager-only view.
--   - Insert / update policies are unchanged. The submit flow on the
--     PWA does `insert().select()` to return the saved row — under
--     "self or admin" SELECT that still works (the staffer can read
--     back their own freshly-inserted row).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Drop the permissive read policy (no-op if already dropped).
drop policy if exists clock_out_reports_select_authn on public.clock_out_reports;

-- Drop the new policy too so this migration is fully re-runnable.
drop policy if exists clock_out_reports_select_self_or_admin on public.clock_out_reports;

-- Gated read policy: staff see their own rows; admins see everyone.
create policy clock_out_reports_select_self_or_admin
  on public.clock_out_reports for select
  to authenticated
  using (
    staff_id = public.current_staff_id()
    OR public.is_admin()
  );

comment on policy clock_out_reports_select_self_or_admin on public.clock_out_reports is
  'Quay 1: non-admin staff see only their own end-of-day clock-out '
  'reports. Admins (is_admin = true) keep cross-staff visibility for '
  'the dashboard All Staff → LN & Assistants sub-tab. Twin of '
  'events_select_self_or_admin and requests_select_self_or_admin.';
