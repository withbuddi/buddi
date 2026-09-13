-- Owner identity and surface pairing (roadmap step 2).
--
-- Surfaces establish *identity*; authorization lives here, in core. A surface
-- never decides who the owner is: it reports (surface, external_user_id,
-- external_chat_id) and core answers.

create table if not exists core.owner (
  id text primary key default 'owner',
  display_name text,
  created_at timestamptz not null default now()
);

-- Paired surface identities: numeric ids only, one row per (surface, user).
create table if not exists core.surface_identities (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references core.owner (id) on delete cascade,
  surface text not null,
  external_user_id text not null,
  external_chat_id text,
  created_at timestamptz not null default now(),
  unique (surface, external_user_id)
);

create index if not exists surface_identities_owner_idx
  on core.surface_identities (owner_id, surface);

-- Polling offset per surface. Advanced only after the update is persisted
-- (ARCHITECTURE.md, "Offline contract").
create table if not exists core.surface_cursors (
  surface text primary key,
  cursor text,
  updated_at timestamptz not null default now()
);

-- Dedup ledger: an update id is processed at most once, ever.
create table if not exists core.surface_updates (
  surface text not null,
  update_id text not null,
  received_at timestamptz not null default now(),
  primary key (surface, update_id)
);

-- One conversation per (surface, chat), so a chat is a continuous thread.
create table if not exists core.surface_conversations (
  surface text not null,
  external_chat_id text not null,
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (surface, external_chat_id)
);
