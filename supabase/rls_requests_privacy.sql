-- ============================================================
-- Quay 1 — Requests privacy gate (Tier 1 #A, RLS-based)
-- ============================================================
-- Twin of rls_events_privacy.sql for the requests table.
--
-- Previously public.requests had a single permissive select policy
-- (requests_select_authn: USING true) which let any authenticated
-- staffer read every other staffer's shift-change reasons + leave
-- requests via sb.from('requests').select('*'). The JS layer's
-- leave_list handler filters by agent_id only when passed one — RLS,
-- not the client, is the source of truth.
--
-- Now:
--   - Staff see only requests where staff_id = their own
--     (resolved via public.current_staff_id())
--   - Admins keep cross-staff read access (via public.is_admin())
--   - Insert / update / delete policies are unchanged
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Drop the permissive read policy (no-op if already dropped).
drop policy if exists requests_select_authn on public.requests;

-- Drop the new policy too so this migration is fully re-runnable.
drop policy if exists requests_select_self_or_admin on public.requests;

-- Gated read policy: staff see their own rows; admins see everyone.
create policy requests_select_self_or_admin
  on public.requests for select
  to authenticated
  using (
    staff_id = public.current_staff_id()
    OR public.is_admin()
  );

comment on policy requests_select_self_or_admin on public.requests is
  'Quay 1: non-admin staff see only their own leave/shift-change '
  'requests. Admins (is_admin = true) keep cross-staff visibility for '
  'the admin dashboard. Twin of events_select_self_or_admin.';
