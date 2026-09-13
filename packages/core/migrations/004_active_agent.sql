-- Per-chat active agent (one bot, many agents).
--
-- A chat now talks to one agent at a time, and each (chat, agent) pair keeps
-- its own conversation: switching with /use resumes that agent's thread rather
-- than dragging the other agent's history along.

-- Which agent a chat is currently talking to. Absent row = the default agent,
-- so an installation that never switches needs no row at all.
create table if not exists core.surface_active_agent (
  surface text not null,
  external_chat_id text not null,
  agent_id text not null,
  updated_at timestamptz not null default now(),
  primary key (surface, external_chat_id)
);

-- Conversations become per (surface, chat, agent). Existing rows predate
-- multiple agents and belong to the finance advisor.
alter table core.surface_conversations
  add column if not exists agent_id text;

update core.surface_conversations
   set agent_id = 'finance-advisor'
 where agent_id is null;

alter table core.surface_conversations
  alter column agent_id set not null;

alter table core.surface_conversations
  drop constraint if exists surface_conversations_pkey;

alter table core.surface_conversations
  add constraint surface_conversations_pkey
  primary key (surface, external_chat_id, agent_id);
