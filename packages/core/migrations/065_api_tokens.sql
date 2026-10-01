-- Owner API tokens (docs/api.md, "Authentication").
--
-- A token lets a script or another program call the dashboard's HTTP API as
-- the owner, with `Authorization: Bearer <token>`, without a browser session.
-- Made and revoked from Settings → API tokens or `buddi api-token`.
--
-- token_hash: sha256 of the token, hex. The token itself is shown once, when
--             it is made, and never stored: a copy of this table cannot be
--             replayed. Tokens are 32 random bytes, so a plain digest is
--             enough; there is nothing to brute-force.
-- hint:       the token's last four characters, so the owner can tell two
--             apart in a list. Not enough to guess the rest.
-- scope:      what it may do. Only 'owner' exists: the owner, minus what
--             api-routes.ts refuses a token (deciding approvals, grants,
--             installing code, access and secrets).
-- created_via: where it was made.
-- last_used_at: written at most once a minute.
-- A revoked token's row is deleted.
create table if not exists core.api_tokens (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  hint text not null check (char_length(hint) = 4),
  scope text not null default 'owner' check (scope in ('owner')),
  created_via text not null check (created_via in ('dashboard', 'cli')),
  created_at timestamptz not null,
  last_used_at timestamptz
);
