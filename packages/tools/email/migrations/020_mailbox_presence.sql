-- Mail moved in another app, Gmail labels, and a trail written before the
-- change (search_path = email, public).
--
-- `messages.gone_at`: the poll found the message no longer in the folder its
-- row names (archived, moved or deleted in another mail app) and could not
-- say where it went — any server but Gmail, or Gmail when no folder has it.
-- The row stays (its triage, thread and history are real); the inbox views,
-- the unread count and the selection tool leave it out. Cleared when buddi
-- finds the message again (a later change, an undo, a reconcile).
--
-- `messages.labels`: Gmail's X-GM-LABELS for a message buddi located after it
-- left the inbox, or moved to a label itself. Null means not known.
--
-- `folders.presence_*`: the inbox as the last presence check saw it (UIDNEXT,
-- EXISTS, HIGHESTMODSEQ). Unchanged UIDNEXT and EXISTS mean nothing left, so
-- the check sends no command at all; a modseq lets a QRESYNC server answer
-- with VANISHED instead of a UID SEARCH.
--
-- `mailbox_actions.state`: `pending` is written before the server is touched
-- (intent first); `done` once every message is recorded; `partial` when an
-- error stopped it part-way (what it did is on the row); `unknown` when a
-- start after a crash could not confirm some of it with the server.
-- `reverted_ids` are the messages of a change an undo already put back, so a
-- partial undo can be finished by undoing the change again.

alter table messages add column if not exists gone_at timestamptz null;
alter table messages add column if not exists labels jsonb null;

-- What the server says a folder is for (SPECIAL-USE: \All, \Archive,
-- \Trash, \Junk), recorded where buddi learns it, so a message's place reads
-- "archived" or "in Trash" rather than a raw folder name.
alter table folders add column if not exists special_use text null;

alter table folders add column if not exists presence_uidnext bigint null;
alter table folders add column if not exists presence_exists integer null;
alter table folders add column if not exists presence_modseq bigint null;

alter table mailbox_actions add column if not exists state text not null default 'done';
alter table mailbox_actions drop constraint if exists mailbox_actions_state_check;
alter table mailbox_actions add constraint mailbox_actions_state_check
  check (state in ('pending', 'done', 'partial', 'unknown'));
alter table mailbox_actions add column if not exists reverted_ids uuid[] not null default '{}';

create index if not exists mailbox_actions_pending_idx on mailbox_actions (account_id) where state = 'pending';
