-- Admin-managed clock-in notification. Admins compose a short reminder
-- ("Kind reminder to be at Obs tomorrow.") on the Clocks dashboard; it pops
-- up to callers when they open the Clock In/Out app in the morning.
create table if not exists public.clock_notifications (
  id         uuid primary key default gen_random_uuid(),
  message    text not null,
  active     boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clock_notifications enable row level security;

-- Any signed-in caller may read active notices (the popup).
drop policy if exists clock_notifications_read on public.clock_notifications;
create policy clock_notifications_read on public.clock_notifications
  for select to authenticated using (true);

-- Only admins create / edit / delete.
drop policy if exists clock_notifications_write on public.clock_notifications;
create policy clock_notifications_write on public.clock_notifications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
