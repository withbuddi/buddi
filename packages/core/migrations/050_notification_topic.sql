-- The same thing from two agents is one row (docs/notifications.md).
--
-- `topic` is what the message is about: its distinctive words, as
-- notifications/topic.ts writes them. A new message whose topic matches an
-- open row's from the last 48 hours folds into that row; `also_from` lists
-- the other agents that said it.
alter table core.owner_notifications add column if not exists topic text;
alter table core.owner_notifications add column if not exists also_from text[] not null default '{}';
