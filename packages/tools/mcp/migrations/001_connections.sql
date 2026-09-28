-- Connections (docs/connections.md): remote MCP servers the owner connected,
-- and the tools each one brought, as the owner reviewed them.
-- Applied with search_path = mcp, public.
--
-- No token is ever here. A connection's OAuth envelope lives in the vault
-- under `vault_ref` (`MCP_CONNECTION_<id>`); this schema holds only its name.

create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  -- The `<connection>` of `mcp.<connection>.<tool>`: chosen at review, unique.
  -- Null until the owner has reviewed the connection's tools.
  slug text unique check (slug is null or slug ~ '^[a-z][a-z0-9_-]{0,23}$'),
  name text not null,
  url text not null,
  host text not null,
  state text not null default 'pending-review'
    check (state in ('connected', 'needs-reconnect', 'unreachable', 'pending-review')),
  auth_kind text not null default 'none' check (auth_kind in ('none', 'oauth')),
  -- The client id buddi registered (or the owner typed) at the authorization server.
  client_id text,
  -- Whether `client_id` came from dynamic registration or from the owner.
  client_source text check (client_source is null or client_source in ('dynamic', 'manual')),
  vault_ref text,
  server_name text,
  server_version text,
  -- sha256 over the reviewed tool list (name, description, schema, annotations).
  reviewed_hash text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tools (
  connection_id uuid not null references connections (id) on delete cascade,
  -- The server's own name for the tool, as it is called.
  name text not null,
  -- The last part of `mcp.<connection>.<tool>`: the name made safe for a model.
  local_name text not null,
  description text not null default '',
  input_schema jsonb not null,
  annotations jsonb,
  tier text not null check (tier in ('auto', 'gated')),
  destructive boolean not null default false,
  enabled boolean not null default true,
  -- sha256 over this tool as it was reviewed.
  reviewed_hash text not null,
  primary key (connection_id, name),
  unique (connection_id, local_name)
);
