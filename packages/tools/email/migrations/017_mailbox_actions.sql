-- Changes buddi makes to the owner's mailbox, and the trail that undoes them
-- (search_path = email, public).
--
-- Until now the plugin only ever read the server. `email.mark`,
-- `email.archive`, `email.move` and `email.trash` write to it — every one of
-- them gated — and so does a policy's on-arrival action. Each change, whoever
-- made it, is one row here: what was done, to which messages, where each one
-- was before and where it went, and who asked. `email.undo` and the Mail
-- page's "Recent changes" read this table to put things back.
--
--  - `origin` says what kind of actor made the change: an agent's approved
--    call, the owner from a page, or a rule applying itself on arrival.
--    `actor` is the agent id, `owner`, or the rule's own words; `policy_id`
--    names the rule when there is one. A rule that applied itself and was
--    learned rather than written is still `origin = policy`: the policy row
--    says where it came from.
--  - `items` is one entry per message: its row id, subject and sender (so the
--    trail reads without a join), and the before and after of whatever
--    changed — flags, folder, uid, Gmail labels. That before is what an undo
--    restores.
--  - An undo is a row of its own (`kind = undo`, `reverts` the row it put
--    back), and the row it reverted is stamped `undone_at`. An undo is never
--    itself undone.

create table if not exists mailbox_actions (
  id uuid primary key default gen_random_uuid(),
  -- Insertion order, for two changes stamped the same instant (an undo right
  -- after the change it puts back, under one clock tick).
  seq bigint generated always as identity,
  account_id uuid not null references accounts (id) on delete cascade,
  kind text not null check (kind in ('mark-read', 'mark-unread', 'archive', 'move', 'trash', 'undo')),
  -- The folder or label a move went to, by its server name. Null otherwise.
  destination text null,
  -- What the selection was, in the words the approval card showed.
  criteria text null,
  origin text not null check (origin in ('agent', 'owner', 'policy')),
  actor text not null default '',
  policy_id uuid null references policies (id) on delete set null,
  run_id text null,
  -- The core action this ran under, when it was an approved call.
  action_id uuid null,
  message_ids uuid[] not null default '{}',
  items jsonb not null default '[]'::jsonb,
  -- How many of `message_ids` were actually changed, and a line about the rest.
  changed integer not null default 0,
  note text null,
  reverts uuid null references mailbox_actions (id) on delete set null,
  undone_at timestamptz null,
  undone_by uuid null references mailbox_actions (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists mailbox_actions_recent_idx on mailbox_actions (account_id, created_at desc, seq desc);

-- A provider that refuses the stored password at poll time. The secret was
-- delivered (core records that use as fine), the server said no: without this
-- the Email settings row kept saying "In the vault" while nothing was read.
-- Cleared by the next login that works, and by Set password.
alter table accounts add column if not exists login_failed_at timestamptz null;
alter table accounts add column if not exists login_error text null;
