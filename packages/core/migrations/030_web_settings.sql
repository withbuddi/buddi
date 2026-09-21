-- Small, owner-facing dashboard settings that are neither a credential nor a
-- domain object: one key, one JSON value.
--
-- The existing `core.provider_settings` is about providers and says so in its
-- check constraints, and a setting like "sign in through Tailscale" has no
-- home there. Rather than grow a column per switch, this is the key/value
-- table the web layer reads and writes, with the shape of each value owned by
-- the module that uses the key (`web/tailscale.ts` for `tailscale`).
--
-- Never a secret: whatever the vault holds stays in the vault. What lands here
-- is configuration an owner could read out loud.
create table if not exists core.web_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
