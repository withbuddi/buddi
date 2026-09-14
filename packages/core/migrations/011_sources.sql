-- Sources: the period ledger for plugins that originate work.
--
-- A source polls the world (IMAP, a file drop) on a period. The *period* is the
-- only thing core owns — the cursor belongs to the plugin, inside its own
-- schema and its own transaction — so this is one row per source id and nothing
-- more. It mirrors core.sentinel_runs on purpose: the two halves of "plugins
-- originate work" are scheduled the same way, and a reader who knows one knows
-- the other.
--
-- last_error is recorded, never thrown: a source talking to a network fails
-- routinely, and a failing source must never be an outage of the tick.

create table if not exists core.source_runs (
  source_id text primary key,
  last_run_at timestamptz not null default now(),
  last_error text null
);
