-- Credentials stay in the vault. Accounts are independent of agents and wires.
create table core.provider_accounts (
  id text primary key,
  label text not null,
  kind text not null check (kind in ('anthropic','openai','openai-compatible')),
  auth text not null check (auth in ('api-key','none','legacy-subscription-token')),
  base_url text not null,
  default_model text not null,
  secret_ref text,
  legacy_env text,
  enabled boolean not null default true,
  deleting boolean not null default false,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (auth <> 'none' or kind = 'openai-compatible'),
  check (auth <> 'legacy-subscription-token' or kind = 'anthropic')
);
create table core.agent_provider_accounts (
  agent_id text primary key,
  account_id text not null references core.provider_accounts(id) on delete restrict,
  model text not null,
  updated_at timestamptz not null default now()
);
create table core.provider_account_migrations (
  name text primary key,
  completed_at timestamptz not null default now()
);
