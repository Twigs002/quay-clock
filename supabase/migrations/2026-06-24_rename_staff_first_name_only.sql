-- One-off rename: drop middle names from 9 staff IDs.
--
-- The original FK constraints on events / requests / clock_out_reports
-- don't have ON UPDATE CASCADE, so a plain UPDATE on staff.id is blocked.
-- We recreate the FKs with ON UPDATE CASCADE so this rename (and any
-- future ones) cascades automatically, then do the rename.

begin;

-- 1. Recreate FKs with ON UPDATE CASCADE
alter table public.events drop constraint events_staff_id_fkey;
alter table public.events add  constraint events_staff_id_fkey
  foreign key (staff_id) references public.staff(id)
  on update cascade on delete cascade;

alter table public.requests drop constraint requests_staff_id_fkey;
alter table public.requests add  constraint requests_staff_id_fkey
  foreign key (staff_id) references public.staff(id)
  on update cascade on delete cascade;

alter table public.clock_out_reports drop constraint clock_out_reports_staff_id_fkey;
alter table public.clock_out_reports add  constraint clock_out_reports_staff_id_fkey
  foreign key (staff_id) references public.staff(id)
  on update cascade on delete cascade;

-- 2. Rename — cascades to events / requests / clock_out_reports automatically.
with renames(old_id, new_id) as (values
  ('declan-ryder-tyler',            'declan'),
  ('douglas-mpiana-nkulu',          'douglas'),
  ('kayleigh-morgan-ducroq',        'kayleigh'),
  ('killarney-mia-jones',           'killarney'),
  ('leon-kudzaishe-salimu',         'leon'),
  ('lisabell-shumirai-panze',       'lisabell'),
  ('shanika-danelle-lotz',          'shanika'),
  ('staddy-victorien-rody-malonga', 'staddy'),
  ('winston-david-mace',            'winston')
)
update public.staff s
   set id = r.new_id
  from renames r
 where s.id = r.old_id;

commit;
