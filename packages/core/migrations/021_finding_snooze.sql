-- A snoozed finding is one the owner has decided to live with. The watcher
-- keeps checking it; it stays out of Home and out of the wake path until it
-- resolves, and a fact that comes back after resolving speaks again.
alter table core.sentinel_findings add column if not exists snoozed_at timestamptz;
