-- Configuration only. Credential values remain in the host vault.
create table core.provider_settings (
  provider text primary key check (provider in ('anthropic', 'openai')),
  credential_kind text not null check (credential_kind in ('auto', 'api-key', 'subscription-token')),
  default_model text not null,
  updated_at timestamptz not null default now(),
  check (provider = 'anthropic' or credential_kind = 'api-key')
);
-- Tombstones prevent a removed vault credential resurrecting from .env.
create table core.provider_credential_state (
  name text primary key check (name in ('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY')),
  removed boolean not null default false,
  updated_at timestamptz not null default now()
);
