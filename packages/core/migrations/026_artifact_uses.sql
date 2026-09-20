-- Files: the library over the artifact store (docs/files.md).
--
-- One artifact can be used in many conversations: dropped in one, reused by
-- dedup in another, produced by an agent in a third. `core.artifacts` holds
-- one conversation_id, which is where it was first saved; this table holds
-- every use, with the kind of use and the agent responsible where one was.
create table if not exists core.artifact_uses (
  artifact_id uuid not null references core.artifacts (id) on delete cascade,
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  -- 'uploaded' by the owner, 'produced' by an agent, 'reused' when dedup
  -- returned a file first saved elsewhere.
  kind text not null check (kind in ('uploaded', 'produced', 'reused')),
  agent_id text null,
  created_at timestamptz not null default now(),
  primary key (artifact_id, conversation_id, kind)
);
create index if not exists artifact_uses_conversation_idx on core.artifact_uses (conversation_id);
create index if not exists artifacts_library_idx on core.artifacts (created_at desc, id desc) where deleted_at is null;

-- Backfill from what the store already knows. Only demonstrable provenance:
-- the row's own conversation, references in transcripts, and surface records.
-- Nothing is inferred from prose.

-- 1. The conversation the artifact was first saved in.
insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id, created_at)
select a.id, a.conversation_id,
       case when a.created_by = 'owner' or a.created_by = '' then 'uploaded' else 'produced' end,
       case when a.created_by = 'owner' or a.created_by = '' then null else a.created_by end,
       a.created_at
  from core.artifacts a
  join core.conversations c on c.id = a.conversation_id
 where a.conversation_id is not null
on conflict do nothing;

-- 2. Every artifact_ref in a stored user turn: an upload the owner sent, or a
--    file reused there. Reused when the artifact was first saved elsewhere.
insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id, created_at)
select distinct on (a.id, m.conversation_id) a.id, m.conversation_id,
       case when a.conversation_id is null or a.conversation_id = m.conversation_id then 'uploaded' else 'reused' end,
       null, m.created_at
  from core.messages m
  cross join lateral jsonb_array_elements(case when jsonb_typeof(m.content) = 'array' then m.content else '[]'::jsonb end) as b
  join core.artifacts a on b->>'type' = 'artifact_ref' and (b->>'artifactId') ~ '^[0-9a-f-]{36}$' and a.id = (b->>'artifactId')::uuid
 where m.role = 'user'
 order by a.id, m.conversation_id, m.created_at asc
on conflict do nothing;

-- 3. Surface attachment records, through the chat's conversation of the day.
insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id, created_at)
select a.id, sc.conversation_id, 'uploaded', null, s.created_at
  from core.surface_attachments s
  join core.surface_conversations sc on sc.surface = s.surface and sc.external_chat_id = s.external_chat_id
  join core.artifacts a on s.artifact_id ~ '^[0-9a-f-]{36}$' and a.id = s.artifact_id::uuid
on conflict do nothing;
