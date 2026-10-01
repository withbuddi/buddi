-- The owner's reactions to an agent's message (docs/telegram.md, "Reactions";
-- docs/learning.md §5).
--
-- `core.surface_sent_messages`: which conversation message, run and agent a
-- message a surface sent stands for. Telegram writes one row per message an
-- answer landed in (a long answer is several), so a reaction on any part of
-- it finds the turn behind it. A run has no id of its own: `run_event_id` is
-- the `run.finished` event that closed it.
--
-- `core.message_feedback`: one row per reacted surface message. A reaction
-- the owner takes back sets `cleared_at`, the row stays: `asked_at` is how a
-- 👎 is asked about once and never again for the same message.

create table if not exists core.surface_sent_messages (
  surface text not null,
  external_chat_id text not null,
  external_message_id text not null,
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  message_id uuid null references core.messages (id) on delete set null,
  run_event_id bigint null,
  agent_id text not null,
  created_at timestamptz not null default now(),
  primary key (surface, external_chat_id, external_message_id)
);

create table if not exists core.message_feedback (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_chat_id text not null,
  external_message_id text not null,
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  message_id uuid null references core.messages (id) on delete set null,
  run_event_id bigint null,
  agent_id text not null,
  value text not null check (value in ('up', 'down', 'neutral')),
  emoji text not null,
  note text null,
  asked_at timestamptz null,
  ask_message_id text null,
  cleared_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_chat_id, external_message_id)
);

create index if not exists message_feedback_message_idx on core.message_feedback (message_id);
create index if not exists message_feedback_updated_idx on core.message_feedback (updated_at);
create index if not exists message_feedback_ask_idx
  on core.message_feedback (source, external_chat_id, ask_message_id)
  where ask_message_id is not null;
