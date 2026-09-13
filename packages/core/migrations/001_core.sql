-- Core schema. Contains no tool-specific tables; plugins own their own schemas.
create table if not exists core.conversations (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists core.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  role text not null,
  content jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on core.messages (conversation_id, created_at);

create table if not exists core.events (
  id bigserial primary key,
  kind text not null,
  conversation_id uuid null references core.conversations (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_kind_idx on core.events (kind, created_at);
create index if not exists events_conversation_idx on core.events (conversation_id, created_at);
