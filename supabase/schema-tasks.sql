-- Quay 1 - Tasks board (data requests / progress / feedback)
-- ============================================================
-- Self-service task tracker. Any signed-in staff member can submit
-- requests (HubSpot exports, dashboard tweaks, "I need X data" kind
-- of things), assign them, comment on them, and watch status flow
-- from open -> in_progress -> done. Lives in the staff PWA at
-- twigs002.github.io/quay-clock/#tasks but the same tables can
-- be read by the perf dashboard later.
--
-- Run once in the Supabase SQL Editor for the quay-clock project.
-- Idempotent.
-- ============================================================

-- 1) tasks
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text default '',
  status        text not null default 'open'
                  check (status in ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority      text not null default 'med'
                  check (priority in ('low', 'med', 'high', 'urgent')),
  due_date      date,
  requested_by  text not null references public.staff(id) on delete set null,
  assigned_to   text references public.staff(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists tasks_status_idx     on public.tasks(status);
create index if not exists tasks_priority_idx   on public.tasks(priority);
create index if not exists tasks_assigned_idx   on public.tasks(assigned_to);
create index if not exists tasks_requested_idx  on public.tasks(requested_by);
create index if not exists tasks_created_idx    on public.tasks(created_at desc);

-- 2) task_comments
create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  author_id   text not null references public.staff(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments(task_id, created_at);

-- 3) updated_at trigger on tasks (so the list can sort by recent activity).
create or replace function public.touch_tasks_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.touch_tasks_updated_at();

-- 4) Bump parent task's updated_at when a new comment lands (so a task
-- with fresh discussion floats up if the UI sorts by updated_at).
create or replace function public.touch_task_on_comment()
returns trigger language plpgsql as $$
begin
  update public.tasks set updated_at = now() where id = new.task_id;
  return new;
end;
$$;
drop trigger if exists task_comments_touch_parent on public.task_comments;
create trigger task_comments_touch_parent
  after insert on public.task_comments
  for each row execute function public.touch_task_on_comment();

-- 5) RLS
alter table public.tasks         enable row level security;
alter table public.task_comments enable row level security;

-- Anyone authenticated can read.
drop policy if exists tasks_select_authn on public.tasks;
create policy tasks_select_authn on public.tasks
  for select to authenticated using (true);

drop policy if exists task_comments_select_authn on public.task_comments;
create policy task_comments_select_authn on public.task_comments
  for select to authenticated using (true);

-- Insert your own row only (requested_by must match caller).
drop policy if exists tasks_insert_self on public.tasks;
create policy tasks_insert_self on public.tasks
  for insert to authenticated
  with check (
    requested_by = (select id from public.staff where auth_user_id = auth.uid())
    or public.is_admin()
  );

drop policy if exists task_comments_insert_self on public.task_comments;
create policy task_comments_insert_self on public.task_comments
  for insert to authenticated
  with check (
    author_id = (select id from public.staff where auth_user_id = auth.uid())
    or public.is_admin()
  );

-- Update: only the requester OR the current assignee OR an admin.
drop policy if exists tasks_update_owner_or_admin on public.tasks;
create policy tasks_update_owner_or_admin on public.tasks
  for update to authenticated
  using (
    public.is_admin()
    or requested_by = (select id from public.staff where auth_user_id = auth.uid())
    or assigned_to  = (select id from public.staff where auth_user_id = auth.uid())
  )
  with check (
    public.is_admin()
    or requested_by = (select id from public.staff where auth_user_id = auth.uid())
    or assigned_to  = (select id from public.staff where auth_user_id = auth.uid())
  );

-- Delete: admin only. (Comments + tasks alike — keeps history clean.)
drop policy if exists tasks_delete_admin on public.tasks;
create policy tasks_delete_admin on public.tasks
  for delete to authenticated using (public.is_admin());

drop policy if exists task_comments_delete_admin on public.task_comments;
create policy task_comments_delete_admin on public.task_comments
  for delete to authenticated using (public.is_admin());

-- 6) Realtime publication.
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.task_comments;
