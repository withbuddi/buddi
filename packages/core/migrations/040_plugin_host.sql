-- The plugin host API (docs/specs/plugin-host-api.md §4.2).
--
-- Two facts `ctx.buddi` scopes by, and nothing else.

-- Which plugin saved which file through `ctx.buddi.files.save`. A plugin sees
-- the files it saved and the files handed into the conversation its tool runs
-- in; the whole library only when it declared `files:library`. A table rather
-- than a column on core.artifacts because files are content-addressed: two
-- plugins saving the same bytes get the same row, and each saved it.
create table if not exists core.plugin_files (
  plugin text not null,
  artifact_id uuid not null references core.artifacts (id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (plugin, artifact_id)
);

-- The model accounts the owner bound to a plugin, from the plugin's own
-- settings page (`ctx.buddi.accounts.bind`, an owner-only call).
-- `accounts.resolve` and `withCodexProfile` are refused for any other. No
-- foreign key to core.provider_accounts, on purpose: that table is truncated
-- and rebuilt whole in places, and a binding to an account that is gone binds
-- nothing — resolving it fails on the account, as it would for anyone.
create table if not exists core.plugin_account_bindings (
  plugin text not null,
  account_id text not null,
  bound_at timestamptz not null default now(),
  primary key (plugin, account_id)
);
