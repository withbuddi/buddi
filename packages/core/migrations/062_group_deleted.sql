-- Deleting a group, with a short way back (docs/groups.md, "Deleting a group").
--
-- A delete marks the row first: the group leaves every list at once and can
-- be restored for a minute. After that the gateway removes it for good — its
-- conversations, their messages and requests, its members, and what the room
-- remembered. The agents themselves are never touched.
alter table core.groups add column if not exists deleted_at timestamptz null;
