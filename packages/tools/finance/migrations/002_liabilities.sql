-- Liabilities: what the owner owes (credit cards, loans).
--
-- Debts, not cash. They are never summed into account balances and never move
-- the projection's start balance; the payments that hit the checking account
-- are already modelled as recurring items, so nothing here is auto-created.

create table if not exists liabilities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null check (kind in ('credit_card', 'loan', 'other')),
  balance numeric(14, 2) not null,
  credit_limit numeric(14, 2) null,
  minimum_payment numeric(14, 2) not null,
  due_day int not null check (due_day between 1 and 31),
  apr numeric(6, 3) null,
  paid_from_account_id uuid null references accounts (id) on delete set null,
  as_of date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists liabilities_active_idx on liabilities (active, kind);
