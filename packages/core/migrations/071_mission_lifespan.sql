-- Missions that stop themselves (docs/missions.md, "When a mission stops").
--
--   stop_when              The agent's own words for when its watch is done
--                          ("the extension is approved"). Shown to every run of
--                          it; null for the owner's and plugins' missions.
--   ends_at                When it switches itself off, quietly. Agent-proposed
--                          watches get one (30 days unless they name another);
--                          null runs until someone stops it.
--   ended_at               When it did, so the dashboard can say "ended" rather
--                          than just "disabled".
--   quiet_runs             Runs in a row that told the owner nothing. Reset by
--                          any report and by the owner's Keep.
--   still_useful_asked_at  When the owner was asked "Still useful?" about it:
--                          asked once, until Keep resets it.
alter table core.missions add column if not exists stop_when text null;
alter table core.missions add column if not exists ends_at timestamptz null;
alter table core.missions add column if not exists ended_at timestamptz null;
alter table core.missions add column if not exists quiet_runs integer not null default 0;
alter table core.missions add column if not exists still_useful_asked_at timestamptz null;
