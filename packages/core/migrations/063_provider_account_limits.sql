-- A model account a provider has rate-limited (docs/providers.md, "Rate limits").
--
-- One row per account while a limit stands: a spent daily quota (scope 'day',
-- until the provider's reset) or a burst window a provider named (scope
-- 'burst'). Calls to an account under a daily limit are refused here instead
-- of hammering the provider; the row goes when the window passes, when a call
-- succeeds, or when the account is edited. Never a key, never a body: the
-- facts are the ones the owner reads ("Gemini's free tier allows 20 requests
-- a day").
create table if not exists core.provider_account_limits (
  account_id text primary key references core.provider_accounts(id) on delete cascade,
  scope text not null check (scope in ('day', 'burst')),
  until timestamptz not null,
  quota integer null,
  unit text null check (unit is null or unit in ('requests', 'tokens')),
  free_tier boolean not null default false,
  provider text null,
  model text null,
  recorded_at timestamptz not null default now()
);
