-- Structured questions asked during a conversation.
--
-- A question is not an approval. Answering one supplies information to a new
-- ordinary turn; every tool tier and approval boundary still applies there.
create table if not exists core.questions (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  question text not null,
  options jsonb not null default '[]'::jsonb,
  allow_other boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz null,
  answered_via text null,
  answer text null,
  constraint questions_options_array check (jsonb_typeof(options) = 'array')
);

create unique index if not exists questions_one_open_per_conversation
  on core.questions (conversation_id) where answered_at is null;

create index if not exists questions_open_idx on core.questions (created_at desc)
  where answered_at is null;
