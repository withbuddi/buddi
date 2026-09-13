-- Credit: the score itself, what gets reported at statement close, and the
-- payment record that drives payment history.
--
-- Utilization is scored off the balance the issuer REPORTS on the statement
-- closing day, not off today's balance, so a card needs both: `statement_day`
-- (when the snapshot is taken) and `reported_balance`/`reported_on` (what the
-- last snapshot actually said). Paying after the statement closes lowers the
-- balance but not the reported utilization for that cycle.

create table if not exists credit_scores (
  id uuid primary key default gen_random_uuid(),
  bureau_or_source text not null,
  score int not null check (score between 250 and 900),
  model text null,
  observed_on date not null default current_date,
  note text null,
  created_at timestamptz not null default now()
);

create index if not exists credit_scores_observed_idx on credit_scores (observed_on desc);

alter table liabilities add column if not exists statement_day int null;
alter table liabilities add column if not exists reported_balance numeric(14, 2) null;
alter table liabilities add column if not exists reported_on date null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'liabilities_statement_day_check'
  ) then
    alter table liabilities
      add constraint liabilities_statement_day_check
      check (statement_day is null or statement_day between 1 and 31);
  end if;
end $$;

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  liability_id uuid not null references liabilities (id) on delete cascade,
  due_on date not null,
  paid_on date null,
  amount numeric(14, 2) null,
  status text not null check (status in ('scheduled', 'paid_on_time', 'paid_late', 'missed')),
  created_at timestamptz not null default now()
);

create index if not exists payment_events_liability_idx
  on payment_events (liability_id, due_on desc);
