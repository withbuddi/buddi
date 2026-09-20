-- Files, second pass (docs/files.md review).
--
-- The uses table is rebuilt: the key now includes the responsible agent, so
-- two agents using one file in one room are two rows; and the backfill only
-- makes claims it can prove — an agent identity is one a conversation names,
-- and no attachment is fanned out across a chat's agents.
drop table if exists core.artifact_uses;

create table core.artifact_uses (
  artifact_id uuid not null references core.artifacts (id) on delete cascade,
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  kind text not null check (kind in ('uploaded', 'produced', 'reused')),
  agent_id text null,
  created_at timestamptz not null default now()
);
create unique index artifact_uses_key on core.artifact_uses (artifact_id, conversation_id, kind, coalesce(agent_id, ''));
create index artifact_uses_conversation_idx on core.artifact_uses (conversation_id);

-- 1. The conversation the artifact was first saved in. Uploaded when the
--    owner saved it; produced only when the creator is an agent some
--    conversation names, or the host tool saved it on an agent's behalf.
insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id, created_at)
select a.id, a.conversation_id, 'uploaded', null, a.created_at
  from core.artifacts a
  join core.conversations c on c.id = a.conversation_id
 where a.conversation_id is not null and a.created_by = 'owner';

insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id, created_at)
select a.id, a.conversation_id, 'produced', a.created_by, a.created_at
  from core.artifacts a
  join core.conversations c on c.id = a.conversation_id
 where a.conversation_id is not null and a.created_by <> 'owner' and a.created_by <> ''
   and (a.source_surface = 'host' or exists (select 1 from core.conversations x where x.agent_id = a.created_by));

-- 2. Every artifact_ref in a stored user turn: the owner sent it there, or it
--    was first saved elsewhere and sent again.
insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id, created_at)
select distinct on (a.id, m.conversation_id) a.id, m.conversation_id,
       case when a.conversation_id is null or a.conversation_id = m.conversation_id then 'uploaded' else 'reused' end,
       null, m.created_at
  from core.messages m
  cross join lateral jsonb_array_elements(case when jsonb_typeof(m.content) = 'array' then m.content else '[]'::jsonb end) as b
  join core.artifacts a on b->>'type' = 'artifact_ref' and (b->>'artifactId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and a.id = (b->>'artifactId')::uuid
 where m.role = 'user'
 order by a.id, m.conversation_id, m.created_at asc
on conflict do nothing;
