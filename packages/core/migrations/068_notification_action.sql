-- What a notification asks the owner to do (docs/notifications.md, "Needs you").
--
-- Needs you holds only what the owner can act on. An approval and a question
-- always are; any other message is information — it still reaches the owner
-- on their channel and stays in Settings → Notifications → Recent — unless it
-- carries an action: a step to take or a question to answer, in a few words
-- ("Confirm with the bank?"). Then it sits in Needs you and counts on every
-- badge until the owner opens it or marks it done.
--
--   action  the ask, scrubbed like the title; null for information.
alter table core.owner_notifications
  add column if not exists action text null;
