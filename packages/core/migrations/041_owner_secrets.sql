-- The owner's secrets (docs/specs/owner-secrets.md §7).
--
-- Names, bindings and uses are rows; values never are. A value lives in the
-- vault buddi already uses, under `owner-secret:<id>`, so a rename never
-- touches the vault and nothing in this schema can be read back as a secret.

-- One secret the owner stored: its name, and whether it is a TOTP seed.
create table if not exists core.secrets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  totp boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Where a secret may go: a destination kind a plugin registered, the exact
-- target within it (checked by the destination), and the approval rule. A
-- secret with no binding can be stored and cannot be used.
-- `first_approved_at` is set when the owner approves the first use under a
-- `first-time` rule; later uses under that binding need no card.
create table if not exists core.secret_bindings (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid not null references core.secrets (id) on delete cascade,
  kind text not null,
  target jsonb not null,
  rule text not null check (rule in ('every-time', 'first-time', 'pre-approved')),
  first_approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (secret_id, kind, target)
);

create index if not exists secret_bindings_kind on core.secret_bindings (kind);

-- Every use asked for, whatever came of it. The secret's name is copied so the
-- log still reads after the secret is deleted. `outcome`:
--   delivered  the destination received the value for this one use;
--   held       an account kind: the plugin's process keeps the value for as
--              long as its connection lives (owner-secrets §4, the exception);
--   pending    a card was raised; `action` is it;
--   refused    no binding, a target the destination refused, no value;
--   failed     the destination threw while delivering.
create table if not exists core.secret_uses (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid references core.secrets (id) on delete set null,
  secret_name text not null,
  kind text not null,
  target jsonb,
  plugin text not null,
  agent_id text,
  conversation_id uuid,
  action_id uuid,
  outcome text not null check (outcome in ('delivered', 'held', 'pending', 'refused', 'failed')),
  detail text,
  at timestamptz not null default now()
);

create index if not exists secret_uses_secret_at on core.secret_uses (secret_id, at desc);
create index if not exists secret_uses_action on core.secret_uses (action_id) where action_id is not null;
