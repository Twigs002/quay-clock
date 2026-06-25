-- 2026-06-25  Absences table — managers mark a staffer absent for a given
--             date so the dashboard distinguishes "told us they wouldn't be
--             in" from "never showed up".

begin;

create table if not exists public.absences (
  id          uuid primary key default gen_random_uuid(),
  staff_id    text        not null references public.staff(id) on update cascade on delete cascade,
  date        date        not null,
  reason      text        not null,        -- Sick / Personal / Family / Approved leave / Other
  reason_note text,                        -- optional free-text addendum
  marked_by   text        not null references public.staff(id) on update cascade,
  marked_at   timestamptz default now(),
  unique (staff_id, date)
);

create index if not exists absences_date_idx  on public.absences (date desc);
create index if not exists absences_staff_idx on public.absences (staff_id);

alter table public.absences enable row level security;

-- Read: any authenticated user. (UI hides absence rows for non-admins.)
drop policy if exists "absences read" on public.absences;
create policy "absences read" on public.absences
  for select to authenticated using (true);

-- Write: admins, super admins, and managers only. Mirrors the dashboard's
-- 'exempt' group: is_admin OR is_super OR designation in (manager, super_admin).
drop policy if exists "absences write" on public.absences;
create policy "absences write" on public.absences
  for all to authenticated
  using (
    exists (
      select 1 from public.staff
      where auth_user_id = auth.uid()
        and (is_admin = true or is_super = true
             or designation in ('manager','super_admin'))
    )
  )
  with check (
    exists (
      select 1 from public.staff
      where auth_user_id = auth.uid()
        and (is_admin = true or is_super = true
             or designation in ('manager','super_admin'))
    )
  );

commit;
