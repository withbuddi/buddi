-- Plugin data a restore kept for later (docs/operations.md, "Restore").
--
-- A restore into an installation that does not have a plugin yet cannot
-- rebuild that plugin's schema, so its part of the archive is staged under
-- <data>/restore/pending/<schema>/ and recorded here. It loads when the plugin
-- is installed and its migrations have run (or at the next start), into tables
-- that are empty; a table that already has rows stays staged and is named in
-- `tables` with its own `kept` sentence.
--
-- tables:     [{ "table": "schema.table", "rows": n, "kept": "why" | null }]
-- migrations: the archive's migration filenames for this schema, the level the
--             data was taken at.
-- reason:     why the last attempt left it waiting, or null before any attempt.
create table if not exists core.pending_plugin_data (
  schema text primary key,
  archive text not null,
  staged_path text not null,
  tables jsonb not null default '[]'::jsonb,
  rows bigint not null default 0,
  migrations jsonb not null default '[]'::jsonb,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
