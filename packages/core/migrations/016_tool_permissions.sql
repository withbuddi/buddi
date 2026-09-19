-- An owner grant, never model input. Empty conversation_id means this agent's
-- future conversations too. Tool upgrades require a fresh decision.
create table core.tool_permissions (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  agent_id text not null,
  tool text not null,
  tool_version text not null,
  conversation_id text not null,
  granted_via text not null,
  created_at timestamptz not null default now(),
  unique (owner_id, agent_id, tool, tool_version, conversation_id)
);
