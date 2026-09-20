-- Groups: a team of agents in one conversation (docs/groups.md).
--
-- A group is fixed membership plus a coordinator. Its conversations are
-- ordinary core.conversations rows tagged with the group, and every message
-- in them records who spoke: the owner, an agent id, or the room itself.
-- The speaker is trusted metadata written by the runtime, never inferred.

create table if not exists core.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  coordinator_agent_id text not null,
  -- The whole room is re-sent to each speaker; this caps it in characters.
  context_cap_chars integer not null default 40000,
  -- Where the last thread stopped, written at rollover, read into the next.
  last_summary text null,
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists core.group_members (
  group_id uuid not null references core.groups (id) on delete cascade,
  agent_id text not null,
  position integer not null default 0,
  primary key (group_id, agent_id)
);

alter table core.conversations add column if not exists group_id uuid null references core.groups (id) on delete set null;
create index if not exists conversations_group_idx on core.conversations (group_id, created_at desc);

-- 'owner', an agent id, or 'room' for a note the orchestration wrote.
-- Null on rows from before groups existed: a single-agent conversation.
alter table core.messages add column if not exists speaker text null;

-- One owner request to a group, with its budget. The counter lives here so
-- it survives an approval pause and a restart; a call is reserved before it
-- is dispatched (see docs/groups.md, "Budget").
create table if not exists core.group_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references core.groups (id) on delete cascade,
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  text text not null,
  state text not null check (state in ('running', 'suspended', 'done', 'failed', 'stopped')),
  budget_total integer not null default 12,
  budget_reserved integer not null default 0,
  maintenance_reserved integer not null default 0,
  awaiting_action_id text null,
  awaiting_agent_id text null,
  note text null,
  created_at timestamptz not null default now(),
  finished_at timestamptz null
);
create index if not exists group_requests_conversation_idx on core.group_requests (conversation_id, created_at desc);
