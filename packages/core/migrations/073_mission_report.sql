-- Host API 1.27: what a mission reads before it runs, how long its report may
-- be, and the voice note a report carries (docs/plugin-host-api.md §7).
--
--   missions.context      { plugin, export, args? }: an export core calls
--                         before each run; its JSON opens the run's first
--                         message. Null for every mission that reads nothing.
--   missions.report_max   The longest report its mission.report takes, in
--                         characters (200–6,000). Null is the default, 1,500.
--   owner_notifications.audio
--                         A Files id: the voice note a report carries. A
--                         channel that plays audio sends it before the text;
--                         any other leaves it.
alter table core.missions add column if not exists context jsonb null;
alter table core.missions add column if not exists report_max integer null;
alter table core.owner_notifications add column if not exists audio uuid null;
