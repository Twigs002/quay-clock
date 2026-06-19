-- ============================================================
-- Quay 1 — Events privacy gate (#29, RLS re-implementation)
-- ============================================================
-- Previously public.events had a single permissive select policy
-- (events_select_authn: USING true) which let any authenticated
-- user read every other staffer's clock events. Symptom: when a
-- regular staff member tapped "Download CSV" on Timesheet they got
-- the whole roster's times, not just their own.
--
-- Attempt #1 fixed this in the JS handler layer (quay-data.js coerced
-- payload.agent_id to the caller's own id when !me.is_admin). That
-- broke clock-in for the whole floor because non-admin paths started
-- failing on a missing _selfStaff cache. Reverted in b3a42fd.
--
-- This migration moves the gate to the database. RLS is enforced
-- before any client query reaches the row layer, so it can't be
-- bypassed by client-side JS or accidentally broken by handler-layer
-- caching. Net effect:
--   - Staff see only events where staff_id = their own
--     (resolved via the existing public.current_staff_id() helper)
--   - Admins keep cross-staff read access (via public.is_admin())
--   - Insert / update / delete policies are unchanged
--     (events_insert_self still lets staff write their own events;
--      events_admin_write still lets admins manage anybody's)
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Drop the permissive read policy (no-op if already dropped).
drop policy if exists events_select_authn on public.events;

-- Also drop the new policy if a prior partial run left it behind,
-- so this migration is fully re-runnable.
drop policy if exists events_select_self_or_admin on public.events;

-- Gated read policy: staff see their own rows; admins see everyone.
create policy events_select_self_or_admin
  on public.events for select
  to authenticated
  using (
    staff_id = public.current_staff_id()
    OR public.is_admin()
  );

-- Sanity comment on the table for future maintainers.
comment on policy events_select_self_or_admin on public.events is
  'Quay 1 #29: non-admin staff see only their own clock events. '
  'Admins (is_admin = true) keep cross-staff visibility for the admin '
  'dashboard. Insert/update/delete stay on events_insert_self + '
  'events_admin_write.';
