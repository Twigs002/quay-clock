-- Quay 1 — superuser tier
-- ============================================================
-- Adds a third role above plain admin:
--   is_admin = false  → can't log in to dashboard/admin
--   is_admin = true, is_super = false  → manager (sees everything except Leadership)
--   is_admin = true, is_super = true   → superuser (sees everything)
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================

alter table public.staff
  add column if not exists is_super boolean not null default false;

-- Promote existing admins to superuser:
--   admin (the bootstrap user) and any row named "sheldon".
update public.staff set is_super = true
  where id in ('admin', 'sheldon')
     or lower(name) = 'sheldon';
