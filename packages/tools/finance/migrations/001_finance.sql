-- finance plugin schema (applied with search_path = finance, public).
-- Read-only tool family: accounts, recurring items, transactions, preferences.

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  balance numeric(14, 2) not null default 0,
  balance_as_of date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists recurring_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('income', 'charge')),
  name text not null,
  amount numeric(14, 2) not null check (amount > 0),
  cadence text not null check (cadence in ('monthly', 'weekly', 'biweekly', 'yearly', 'once')),
  anchor_date date not null,
  account_id uuid null references accounts (id) on delete set null,
  category text null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists recurring_items_active_idx on recurring_items (active, kind);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid null references accounts (id) on delete set null,
  occurred_on date not null,
  amount numeric(14, 2) not null,
  description text not null,
  category text null,
  source text not null check (source in ('manual', 'csv')),
  dedup_hash text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists transactions_occurred_idx on transactions (occurred_on);
create index if not exists transactions_account_idx on transactions (account_id, occurred_on);

create table if not exists preferences (
  key text primary key,
  value jsonb not null
);
