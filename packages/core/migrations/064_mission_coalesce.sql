-- Coalescing a mission's event-driven runs (docs/architecture.md, "Sentinels").
--
-- A mission that opts in gathers the occurrences enqueued for the same agent
-- within a short window into one run carrying all of them: the first one
-- waits `coalesce_window_seconds` for company, each arrival pushes the run
-- back by the window again, and none waits longer than
-- `coalesce_max_wait_seconds` after the first. Null is the default: one run
-- per occurrence, as before.
alter table core.missions add column if not exists coalesce_window_seconds integer null
  check (coalesce_window_seconds is null or coalesce_window_seconds between 1 and 3600);
alter table core.missions add column if not exists coalesce_max_wait_seconds integer null
  check (coalesce_max_wait_seconds is null or coalesce_max_wait_seconds between 1 and 86400);
