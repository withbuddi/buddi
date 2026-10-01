-- On-arrival rule actions still to do (search_path = email, public).
--
-- A new message is stamped (`messages.triage_enqueued_at`) once its triage
-- run is queued, before its rule's mailbox action (archive, mark read, move)
-- runs over a connection of its own. Should that connection fail, the stamp
-- means the message is never drained again — so the action is owed here,
-- written before the stamp (or in the same transaction as an ignore's), and
-- the next poll retries it. A row goes once the action is on the trail (or
-- there is nothing left to do: the message or the rule is gone, or the
-- message is no longer where the rule would act); after `attempts` reaches
-- the poll's limit it stays as the record of a rule that could not act.
-- The trail's own guard (a message already on the trail for that rule) still
-- keeps a retry from acting twice.

create table if not exists arrival_pending (
  message_id uuid not null references messages (id) on delete cascade,
  policy_id uuid not null references policies (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  attempts integer not null default 0,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, policy_id)
);

create index if not exists arrival_pending_account_idx on arrival_pending (account_id, attempts);
