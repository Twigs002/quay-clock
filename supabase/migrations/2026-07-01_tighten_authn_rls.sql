-- Quay Clock — tighten "using(true)" policies on sensitive tables
-- =================================================================
-- Audit findings C3, C4, C6 (all P1), plus a P2 lead_events tightening.
--
-- All four tables previously used `using(true)` for authenticated select,
-- meaning any staffer with a valid JWT could dump other people's clock
-- events, leave requests, absence reasons, and manager red-flag acks
-- via devtools. Tighten to self-or-admin (events/requests/absences) or
-- admin/manager only (flag_acks, live_stats, lead_events).
--
-- UX still works: the UI's client-side hide-for-non-admin logic remains,
-- and RLS just backstops it so devtools can't bypass.

-- ── EVENTS ────────────────────────────────────────────────────────
-- C6 — clock events (personal work timing) — self OR admin.
drop policy if exists events_select_authn on public.events;
drop policy if exists events_select_self_or_admin on public.events;

create policy events_select_self_or_admin
  on public.events for select to authenticated
  using (
    staff_id = public.current_staff_id()
    or public.is_admin()
    or public.is_super_flag()
  );

-- ── REQUESTS ──────────────────────────────────────────────────────
-- C6 — leave/shift requests carry the staffer's reason text — self OR admin.
drop policy if exists requests_select_authn on public.requests;
drop policy if exists requests_select_self_or_admin on public.requests;

create policy requests_select_self_or_admin
  on public.requests for select to authenticated
  using (
    staff_id = public.current_staff_id()
    or public.is_admin()
    or public.is_super_flag()
  );

-- ── ABSENCES ──────────────────────────────────────────────────────
-- C3 — absences.reason_note is medical/personal. Self OR admin only.
drop policy if exists "absences read" on public.absences;
drop policy if exists absences_select_self_or_admin on public.absences;

create policy absences_select_self_or_admin
  on public.absences for select to authenticated
  using (
    staff_id = public.current_staff_id()
    or public.is_admin()
    or public.is_super_flag()
  );

-- ── FLAG_ACKS (dashboard v2) ───────────────────────────────────────
-- C4 — red-flag acks are manager territory. Admin/manager read only.
-- Also lock select+delete which were world-writable to authenticated.
do $$ begin
  if to_regclass('public.flag_acks') is not null then
    execute 'alter table public.flag_acks enable row level security';
    execute 'drop policy if exists flag_acks_read on public.flag_acks';
    execute 'drop policy if exists flag_acks_read_admin on public.flag_acks';
    execute 'create policy flag_acks_read_admin on public.flag_acks
             for select to authenticated
             using (public.is_admin() or public.is_super_flag())';
    execute 'drop policy if exists flag_acks_update_admin on public.flag_acks';
    execute 'create policy flag_acks_update_admin on public.flag_acks
             for update to authenticated
             using (public.is_admin() or public.is_super_flag())
             with check (public.is_admin() or public.is_super_flag())';
    execute 'drop policy if exists flag_acks_delete_admin on public.flag_acks';
    execute 'create policy flag_acks_delete_admin on public.flag_acks
             for delete to authenticated
             using (public.is_admin() or public.is_super_flag())';
  end if;
end $$;

-- ── LIVE_STATS (dashboard v2) ─────────────────────────────────────
-- C8 (P2) — realtime call/lead counts per agent. Admin/manager only —
-- LN/Assistants shouldn't dashboard-scrape the whole floor's stats.
do $$ begin
  if to_regclass('public.live_stats') is not null then
    execute 'alter table public.live_stats enable row level security';
    execute 'drop policy if exists live_stats_read on public.live_stats';
    execute 'drop policy if exists live_stats_read_admin on public.live_stats';
    execute 'create policy live_stats_read_admin on public.live_stats
             for select to authenticated
             using (public.is_admin() or public.is_super_flag())';
  end if;
end $$;

-- ── LEAD_EVENTS (quay-clock) ──────────────────────────────────────
-- C7 (P2) — raw Dialfire payload jsonb. Admin only.
do $$ begin
  if to_regclass('public.lead_events') is not null then
    execute 'alter table public.lead_events enable row level security';
    execute 'drop policy if exists lead_events_read on public.lead_events';
    execute 'drop policy if exists lead_events_read_admin on public.lead_events';
    execute 'create policy lead_events_read_admin on public.lead_events
             for select to authenticated
             using (public.is_admin() or public.is_super_flag())';
  end if;
end $$;
