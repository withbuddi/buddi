-- Accounts are plural (applied with search_path = email, public).
--
-- docs/specs/email.md §2: "Accounts are plural, and a reply leaves from the account
-- it answers." The schema has always had an `accounts` table with a unique
-- address; what it lacked was everything that makes a *second* row meaningful:
-- an identity beyond the address, a way to turn one off without deleting its
-- mail, and a record of how it got here.
--
--  - `aliases` are the other addresses this account receives as. They are
--    identity, not routing: a reply's From is the alias the original was
--    addressed to when it is one of these, and the account's address otherwise.
--  - `display_name` is what the owner calls it on the settings page. Null means
--    "the address is the name", which is the honest default rather than a
--    duplicate of it.
--  - `enabled` is the switch. A disabled account keeps every message, every
--    draft and its cursor; it is simply not polled and not read across. That is
--    the difference between "pause this mailbox" and "forget it ever existed",
--    and only the second one is a delete.
--  - `added_via` says where the row came from. 'env' is the GMAIL_USER seed,
--    which is re-run on every boot and must keep working; 'page' is an account
--    the owner added from Settings, whose password is in the vault under the
--    name this row carries. The seed must never overwrite what the page wrote,
--    and the column is what lets it tell.
--
-- Nothing here is nullable-and-hoped-about: every existing row is an env-seeded
-- account, enabled, with no aliases, and the defaults say exactly that.

alter table accounts add column if not exists aliases text[] not null default '{}';
alter table accounts add column if not exists display_name text null;
alter table accounts add column if not exists enabled boolean not null default true;
alter table accounts add column if not exists added_via text not null default 'env';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'accounts_added_via_check'
  ) then
    alter table accounts
      add constraint accounts_added_via_check check (added_via in ('env', 'page'));
  end if;
end
$$;

-- Which accounts the poll and the read tools walk. Small table, but the
-- predicate is on every one of those queries.
create index if not exists accounts_enabled_idx on accounts (enabled) where enabled;

-- A draft belongs to the account it will leave from.
--
-- Until now there was one account, so the draft's account was "the one". With
-- two, `email.send` has to know which mailbox authenticates the dispatch and
-- which identity goes on the From line, and a draft that does not carry it
-- would be guessing at the one thing the owner is approving.
--
-- `on delete set null` rather than cascade: removing an account is not a reason
-- to destroy the record of what was drafted and sent from it. A draft with no
-- account cannot be sent, and `email.send` says so instead of picking one.
alter table drafts add column if not exists account_id uuid null
  references accounts (id) on delete set null;

-- Every draft written before this column existed belongs to the only account
-- this installation had.
update drafts
   set account_id = (select id from accounts order by created_at asc, address asc limit 1)
 where account_id is null;

create index if not exists drafts_account_idx on drafts (account_id);
