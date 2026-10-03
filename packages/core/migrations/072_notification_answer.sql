-- The owner's answer to a notification that asked something with buttons
-- ("Still useful?": keep or stop). Written when the question is claimed, so a
-- later tap on the same prompt reports what was decided and changes nothing.
alter table core.owner_notifications add column if not exists answer text null;
