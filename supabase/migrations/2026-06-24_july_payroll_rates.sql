-- 2026-06-24  Apply July 2026 payroll hourly rates + onboard 2 new brokers.
--
-- Source: "Aqua Promotions - Agents & Callers Payroll.xlsx" sheet
-- " ConnectTeams July 2026" (downloaded 2026-06-24).
--
-- Applied via REST/admin API at the time; this file is the audit trail.
-- Idempotent: re-running on a fresh DB sets the same rates and is safe.
-- Note: the two new staff rows reference auth.users entries that were
-- created at runtime via the Supabase admin API (cannot be created via
-- plain SQL — see the bottom of this file for details).

begin;

-- ── Hourly rate updates (39 rows) ─────────────────────────────────────
update public.staff set hourly_rate = 77.52 where id = 'jason-julius';
update public.staff set hourly_rate = 69.77 where id = 'maud';
update public.staff set hourly_rate = 66.98 where id = 'josh-adonis';
update public.staff set hourly_rate = 64.60 where id = 'anne-mary-marias';
update public.staff set hourly_rate = 62.02 where id = 'reidhistra-govinder';
update public.staff set hourly_rate = 62.02 where id = 'claire';
update public.staff set hourly_rate = 56.85 where id = 'bronwyn-botha';
update public.staff set hourly_rate = 56.85 where id = 'gcisa-sokwaliwa';
update public.staff set hourly_rate = 56.85 where id = 'simone-vermeulen';
update public.staff set hourly_rate = 56.85 where id = 'killarney';
update public.staff set hourly_rate = 54.26 where id = 'douglas';
update public.staff set hourly_rate = 51.68 where id = 'quinn';
update public.staff set hourly_rate = 51.68 where id = 'aqeefah-arendse';
update public.staff set hourly_rate = 51.68 where id = 'lisabell';
update public.staff set hourly_rate = 51.68 where id = 'winston';
update public.staff set hourly_rate = 51.68 where id = 'tamzin-jacobs';
update public.staff set hourly_rate = 51.68 where id = 'zivana-kriel';
update public.staff set hourly_rate = 51.68 where id = 'giovon-van-wyk';
update public.staff set hourly_rate = 51.68 where id = 'siphesihle-sibanyoni';
update public.staff set hourly_rate = 49.10 where id = 'kayleigh';
update public.staff set hourly_rate = 49.10 where id = 'neelam-jameel';
update public.staff set hourly_rate = 49.10 where id = 'sadiqa-carelse';
update public.staff set hourly_rate = 49.10 where id = 'basil-tambwe';
update public.staff set hourly_rate = 49.10 where id = 'warrick-solomons';
update public.staff set hourly_rate = 49.10 where id = 'staddy';
update public.staff set hourly_rate = 49.10 where id = 'matthew-hallett';
update public.staff set hourly_rate = 46.51 where id = 'craig-carroll';
update public.staff set hourly_rate = 46.51 where id = 'whitney-malgas';
update public.staff set hourly_rate = 46.51 where id = 'geneva-maggie-nela-gomez';
update public.staff set hourly_rate = 46.51 where id = 'shanika';
update public.staff set hourly_rate = 46.51 where id = 'jaco';
update public.staff set hourly_rate = 43.93 where id = 'qhayiya-dayimani';
update public.staff set hourly_rate = 41.34 where id = 'declan';
update public.staff set hourly_rate = 41.34 where id = 'anneeqa-williams';
update public.staff set hourly_rate = 41.34 where id = 'janice';
update public.staff set hourly_rate = 41.34 where id = 'nicolette';
update public.staff set hourly_rate = 38.76 where id = 'jason-hendricks';
update public.staff set hourly_rate = 36.18 where id = 'jamie-lee';
update public.staff set hourly_rate = 25.84 where id = 'leon';

-- ── New staff (2 Broker Assistants) ───────────────────────────────────
-- auth.users rows were created via the Supabase admin API with:
--   email: niel@quay1.local     password: 123456    confirmed
--   email: richard@quay1.local  password: 123456    confirmed
-- (PINs are passwords on the auth.users row — the clock app maps
-- username -> "<id>@quay1.local" and signs in with the PIN.)
insert into public.staff (id, auth_user_id, name, role, designation, active, hourly_rate)
values
  ('niel',    '6b05e77f-e0ea-47af-b952-f5564ed8960c', 'Niel Steenkamp',     'Assistant', 'assistant', true, 43.93),
  ('richard', 'de87b95b-d166-48ff-814c-4aa8d77b3a36', 'Richard Du Plessis', 'Assistant', 'assistant', true, 51.68)
on conflict (id) do nothing;

commit;
