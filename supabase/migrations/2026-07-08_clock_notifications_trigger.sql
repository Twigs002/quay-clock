-- Notices can fire either when a caller clocks IN (morning reminder) or when
-- they clock OUT (end-of-day reminder). Admin picks per notice; default is
-- clock-in to preserve the original behaviour.
alter table public.clock_notifications
  add column if not exists trigger text not null default 'clock_in';

alter table public.clock_notifications
  drop constraint if exists clock_notifications_trigger_chk;
alter table public.clock_notifications
  add constraint clock_notifications_trigger_chk
  check (trigger in ('clock_in', 'clock_out'));
