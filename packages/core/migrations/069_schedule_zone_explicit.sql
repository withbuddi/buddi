-- Whether a schedule's zone was named on purpose (docs/system-context.md, "The owner's zone").
--
-- A schedule made without a zone follows the owner's: Settings → Profile,
-- else BUDDI_TZ, else New York. A Profile change moves it (a new revision,
-- so its next run is computed in the new zone). A schedule whose creator
-- named a zone — a tool's `timezone`, a plugin's mission that declares one,
-- the dashboard's choice — keeps it.
--
--   timezone_explicit  true: named on purpose, kept; false: follows the owner.
--                      null: made before this column; settled once at the
--                      next start (`settleScheduleZones`), where a schedule in
--                      the zone that was the default when it was made (the
--                      install's BUDDI_TZ, else New York) or in the Profile's
--                      zone follows the owner and any other keeps its zone.
alter table core.schedule_specs
  add column if not exists timezone_explicit boolean null;
