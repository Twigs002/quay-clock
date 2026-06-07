-- Quay 1 — Supabase schema
-- ============================================================
-- Run this once in the Supabase SQL Editor for the quay-clock project.
-- It is idempotent: re-running won't drop data, but it WILL refresh
-- policies and helper functions in place.
-- ============================================================

-- 1. Extensions ------------------------------------------------
create extension if not exists pgcrypto;

-- 2. Tables ----------------------------------------------------
-- Staff (roster). Primary key = username slug ("thandi", "rashied", ...)
create table if not exists public.staff (
  id            text primary key,
  auth_user_id  uuid unique references auth.users(id) on delete set null,
  name          text not null,
  role          text default '',
  team          text default '',
  is_admin      boolean not null default false,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists staff_auth_user_idx on public.staff(auth_user_id);
create index if not exists staff_active_idx on public.staff(active);

-- Events (clock in / clock out)
create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  staff_id      text not null references public.staff(id) on delete cascade,
  ts            timestamptz not null,
  dir           text not null check (dir in ('in', 'out')),
  note          text default '',
  location      text default '',
  duration_hrs  numeric(10, 4),
  created_at    timestamptz not null default now()
);
create index if not exists events_staff_ts_idx on public.events(staff_id, ts desc);
create index if not exists events_ts_idx on public.events(ts desc);

-- Requests (leave + shift changes)
create table if not exists public.requests (
  id            uuid primary key default gen_random_uuid(),
  staff_id      text not null references public.staff(id) on delete cascade,
  type          text not null,
  start_date    date not null,
  end_date      date not null,
  days          numeric(5, 2) not null default 1,
  reason        text default '',
  status        text not null default 'Pending'
                  check (status in ('Pending', 'Approved', 'Declined')),
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists requests_staff_idx on public.requests(staff_id);
create index if not exists requests_status_idx on public.requests(status);
create index if not exists requests_dates_idx on public.requests(start_date, end_date);

-- 3. Helper functions -----------------------------------------
-- security definer so RLS policies can call them without recursing on RLS.
create or replace function public.current_staff_id()
returns text language sql stable security definer
set search_path = public
as $$
  select id from public.staff where auth_user_id = auth.uid() limit 1;
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select is_admin from public.staff where auth_user_id = auth.uid()),
    false
  );
$$;

-- 4. Row-level security --------------------------------------
alter table public.staff    enable row level security;
alter table public.events   enable row level security;
alter table public.requests enable row level security;

-- Wipe any existing policies so re-runs land cleanly.
do $$ begin
  perform 1 from pg_policies where schemaname = 'public' and tablename = 'staff';
  if found then
    execute (select string_agg(format('drop policy if exists %I on public.staff;', policyname), ' ')
             from pg_policies where schemaname='public' and tablename='staff');
  end if;
  perform 1 from pg_policies where schemaname = 'public' and tablename = 'events';
  if found then
    execute (select string_agg(format('drop policy if exists %I on public.events;', policyname), ' ')
             from pg_policies where schemaname='public' and tablename='events');
  end if;
  perform 1 from pg_policies where schemaname = 'public' and tablename = 'requests';
  if found then
    execute (select string_agg(format('drop policy if exists %I on public.requests;', policyname), ' ')
             from pg_policies where schemaname='public' and tablename='requests');
  end if;
end $$;

-- STAFF
-- Authenticated users see the roster (needed for Team views).
create policy staff_select_authn
  on public.staff for select to authenticated
  using (true);

-- Only admins can add / edit / disable staff.
create policy staff_admin_write
  on public.staff for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- EVENTS
create policy events_select_authn
  on public.events for select to authenticated
  using (true);

-- Staff can insert events for themselves only.
create policy events_insert_self
  on public.events for insert to authenticated
  with check (staff_id = public.current_staff_id());

-- Admins can do anything to events (add / edit / delete on anyone's behalf).
create policy events_admin_write
  on public.events for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- REQUESTS
create policy requests_select_authn
  on public.requests for select to authenticated
  using (true);

create policy requests_insert_self
  on public.requests for insert to authenticated
  with check (staff_id = public.current_staff_id());

-- Staff can update only their own pending requests (e.g. cancel).
create policy requests_update_self_pending
  on public.requests for update to authenticated
  using (staff_id = public.current_staff_id() and status = 'Pending')
  with check (staff_id = public.current_staff_id() and status = 'Pending');

create policy requests_admin_write
  on public.requests for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 5. Realtime --------------------------------------------------
-- Make the team-status view reactive so "who's working now" updates live.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'requests'
  ) then
    alter publication supabase_realtime add table public.requests;
  end if;
end $$;

-- Done.
