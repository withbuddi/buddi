-- Card ledgers: a transaction can now live on a liability, not only on cash.
--
-- Until now every transaction had to belong to a cash account, so a card
-- purchase — the GEICO premium billed to the Mastercard, a restaurant paid on
-- the Amex — had nowhere to live. It was either invented as a cash outflow
-- (wrong: no cash moved that day) or not recorded at all (worse: the advisor
-- cannot say when the charge hits, and the statement balance cannot be
-- forecast). A card is a ledger of its own, and this is where it gets one.
--
-- Sign convention on a liability, chosen to match the cash one so a single
-- `amount` column keeps one meaning everywhere:
--
--   negative = a CHARGE     — money spent on the card, which RAISES what is owed
--   positive = a PAYMENT or CREDIT — which LOWERS what is owed
--
-- (On a cash account negative is still money out of the account. In both cases
-- negative is the owner spending and positive is the owner receiving.)
--
-- A row belongs to exactly one ledger: `account_id` XOR `liability_id`. The
-- balance columns on accounts and liabilities stay what they always were —
-- stated figures the owner confirms, never a running sum of these rows.
--
-- The foreign keys are `on delete restrict`, not `set null`: a liability with
-- transactions on it cannot be deleted out from under them, which is both the
-- rule ("never delete rows") and what keeps the XOR check satisfiable.

/* ------------------------------------------------------------ transactions */

alter table transactions add column if not exists liability_id uuid null
  references liabilities (id) on delete restrict;

-- Nullable already in 001; stated again so the intent survives a fresh read.
alter table transactions alter column account_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_ledger_check'
  ) then
    alter table transactions
      add constraint transactions_ledger_check
      check ((account_id is null) <> (liability_id is null));
  end if;
end $$;

create index if not exists transactions_liability_idx
  on transactions (liability_id, occurred_on);

/* --------------------------------------------------------- recurring items */

alter table recurring_items add column if not exists liability_id uuid null
  references liabilities (id) on delete restrict;

-- At most one ledger here, not exactly one. An item with NEITHER has always
-- been legal and is in the owner's data today ('BofA auto loan payment' with no
-- account named): the projection reads it as hitting the cash, and tightening
-- that to exactly-one would make `account` mandatory on finance.add_recurring
-- and reject rows that are already recorded. What must never happen is BOTH —
-- a charge cannot be billed to a card and drawn from a checking account at the
-- same time — and that is what this forbids.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'recurring_items_ledger_check'
  ) then
    alter table recurring_items
      add constraint recurring_items_ledger_check
      check (account_id is null or liability_id is null);
  end if;
end $$;

create index if not exists recurring_items_liability_idx
  on recurring_items (liability_id, active);

/* --------------------------------------------------------- import stagings */

alter table import_stagings add column if not exists liability_id uuid null
  references liabilities (id) on delete restrict;

alter table import_stagings alter column account_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'import_stagings_ledger_check'
  ) then
    alter table import_stagings
      add constraint import_stagings_ledger_check
      check ((account_id is null) <> (liability_id is null));
  end if;
end $$;
