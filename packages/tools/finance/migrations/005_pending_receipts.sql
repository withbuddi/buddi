-- Pending vs posted money, receipts, and two-phase statement imports.
--
-- Three facts the ledger could not express before:
--
--   1. A charge can be *committed* without being *settled*. A pending card
--      authorisation is money the owner no longer has, but it is not yet a
--      posted line, and when it does post the bank emits a second row. Without
--      a status the ledger either double-counts it or ignores it entirely.
--      `status` names which it is and `superseded_by` points a pending row at
--      the posted row that replaced it — a superseded pending row is invisible
--      everywhere, never deleted, so the history of what was seen survives.
--   2. Matching a pending row to its posted twin (or a receipt to a charge)
--      needs the merchant, not the bank's raw description. `merchant_norm` is
--      that description with the noise — digits, card numbers, POS/PIN
--      markers, punctuation — stripped out, so 'POS PURCHASE CARD1234 LIDL
--      #883' and 'LIDL' meet on the same string.
--   3. A row can come from a document the owner sent. `artifact_id` records
--      which one, with no foreign key: artifacts live in another plugin's
--      table and this schema never reaches across that line.

alter table transactions add column if not exists status text not null default 'posted';
alter table transactions add column if not exists superseded_by uuid null
  references transactions (id) on delete set null;
alter table transactions add column if not exists merchant_norm text null;
alter table transactions add column if not exists artifact_id uuid null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_status_check') then
    alter table transactions
      add constraint transactions_status_check check (status in ('pending', 'posted'));
  end if;
end $$;

-- Rows can now come from a statement the owner sent, read by the model rather
-- than by a parser and staged for confirmation before they are written.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'transactions_source_check') then
    alter table transactions drop constraint transactions_source_check;
  end if;
  alter table transactions
    add constraint transactions_source_check check (source in ('manual', 'csv', 'statement'));
end $$;

create index if not exists transactions_status_idx on transactions (status, occurred_on);
create index if not exists transactions_merchant_norm_idx on transactions (merchant_norm);

-- Backfill. Mirrors normalizeMerchant() in src/merchant.ts step for step:
-- lowercase, drop 'card1234'/'carte 1234', drop the POS/PIN/ACH-style noise
-- words, drop every remaining digit and punctuation mark, collapse whitespace.
update transactions
   set merchant_norm = trim(
     regexp_replace(
       regexp_replace(
         regexp_replace(
           regexp_replace(
             -- Apostrophes are deleted, not blanked: "Trader Joe's" -> 'trader joes'.
             regexp_replace(lower(description), '[''‘’`]', '', 'g'),
             '\m(card|carte)\s*[0-9]+', ' ', 'g'
           ),
           '\m(pos|pin|ach|dbt|dda|debit|credit|purchase|payment|paiement|txn|trn|ref|xxx+)\M',
           ' ',
           'g'
         ),
         '[^a-z ]+', ' ', 'g'
       ),
       '\s+', ' ', 'g'
     )
   )
 where merchant_norm is null;

-- Receipts: what the owner actually bought, which is not the same fact as what
-- the bank charged. A receipt lives on its own (it can arrive before the
-- charge posts, or for a charge that never appears) and is linked to a
-- transaction only when one matches.
create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  merchant text not null,
  merchant_norm text not null,
  occurred_on date not null,
  total numeric(14, 2) not null,
  currency text not null default 'USD',
  -- [{ name, qty, price }] — the line items, when the document had them.
  items jsonb null,
  artifact_id uuid null,
  transaction_id uuid null references transactions (id) on delete set null,
  notes text null,
  created_at timestamptz not null default now()
);

create index if not exists receipts_occurred_idx on receipts (occurred_on);
create index if not exists receipts_unmatched_idx on receipts (transaction_id);
create index if not exists receipts_merchant_norm_idx on receipts (merchant_norm);

-- Staged imports: rows extracted from a statement, held until the owner says
-- commit. Nothing here is part of the ledger — `rows` is the proposal and
-- `summary` is what the owner was shown. An uncommitted staging expires on its
-- own so a forgotten confirmation can never be applied hours later.
create table if not exists import_stagings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  source text not null check (source in ('statement', 'csv', 'manual')),
  artifact_id uuid null,
  rows jsonb not null,
  summary jsonb not null,
  created_at timestamptz not null default now(),
  committed_at timestamptz null,
  expires_at timestamptz not null default now() + interval '2 hours'
);

create index if not exists import_stagings_open_idx on import_stagings (committed_at, expires_at);
