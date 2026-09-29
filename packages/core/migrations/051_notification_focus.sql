-- Focus modes (docs/notifications.md, "Focus").
--
-- `focus` is the owner's manual focus: { mode, until, startedAt, by }, null
-- when none is on. `schedules` is the list of { mode, days, from, to } that
-- replaced quiet hours; null means "never set", and quiet hours still set are
-- moved into it here as Do not disturb on every day. `held_for` on a row is
-- the focus mode that held it, so the end of that focus can say what waited.
alter table core.notification_settings add column if not exists focus jsonb;
alter table core.notification_settings add column if not exists schedules jsonb;
alter table core.owner_notifications add column if not exists held_for text;

update core.notification_settings
   set schedules = jsonb_build_array(jsonb_build_object(
         'mode', 'do-not-disturb',
         'days', '["mon","tue","wed","thu","fri","sat","sun"]'::jsonb,
         'from', quiet_start,
         'to', quiet_end)),
       quiet_start = null,
       quiet_end = null
 where schedules is null and quiet_start is not null and quiet_end is not null and quiet_start <> quiet_end;
