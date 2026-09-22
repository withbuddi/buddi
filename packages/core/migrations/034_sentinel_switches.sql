-- A watcher the owner has switched off.
--
-- Sentinels arrive with a plugin and run on a period; until now the only way
-- to stop one was to uninstall the plugin that shipped it, which is the wrong
-- granularity — "tell me when mail waits on me" and "read my mail at all" are
-- not the same decision. The Watchers page shows one switch per watcher and
-- this table is what it writes.
--
-- Absent means on. A watcher is useful by default, a row exists only because
-- somebody touched the switch, and an installation that never opens the page
-- needs no rows at all. `runSentinels` reads the table once per tick and skips
-- what is off: a watcher that is off does not run, raises nothing, and resolves
-- nothing — its open findings stay exactly as they were, so switching it back
-- on does not replay a week of news.
create table if not exists core.sentinel_switches (
  sentinel_id text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
