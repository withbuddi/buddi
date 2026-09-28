-- Connections, slice 3 (docs/connections.md, "Review again" and "Unreachable").
-- Applied with search_path = mcp, public.

-- A server whose tool list changed since the owner's review waits in
-- `needs-review`: its unchanged tools keep working, the rest wait.
alter table connections drop constraint if exists connections_state_check;
alter table connections add constraint connections_state_check
  check (state in ('connected', 'needs-reconnect', 'unreachable', 'pending-review', 'needs-review'));

-- When the connection stopped answering; null while it answers.
alter table connections add column if not exists unreachable_since timestamptz;

-- A reviewed tool the server changed or dropped since the review: not
-- registered until the owner reviews the connection again.
alter table tools add column if not exists changed boolean not null default false;
