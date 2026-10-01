-- How the owner reads times and dates (docs/dashboard.md, Settings → Profile).
--
-- time_format: `12h` (2:05 PM) or `24h` (14:05); null is Auto, the browser's
--              own locale.
-- date_format: `short` (Thu, Oct 1), `long` (Thursday, 1 October) or `iso`
--              (2026-10-01); null is Auto.
-- Every date and time the dashboard draws goes through one formatter that
-- reads these, and every agent is told them beside the timezone.
alter table core.owner add column if not exists time_format text check (time_format in ('12h', '24h'));
alter table core.owner add column if not exists date_format text check (date_format in ('short', 'long', 'iso'));
