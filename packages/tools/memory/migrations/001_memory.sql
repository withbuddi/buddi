-- memory plugin schema (applied with search_path = memory, public).
--
-- Two separated kinds (docs/architecture.md, "Memory"):
--   preferences — user-authored, versioned, correctable. A correction is a NEW
--                 revision; the previous one is superseded, never overwritten,
--                 so "what did I used to want" stays answerable.
--   notes       — derived memories. Every row carries provenance (which agent
--                 wrote it, from which conversation), a scope, and an optional
--                 expiry. Deletion is a soft delete: the row stays auditable.
--
-- Memory informs reasoning; it never grants permission. Nothing in this schema
-- is consulted by the authorization path, and nothing here is a capability.

create table if not exists preferences (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  value text not null,
  revision integer not null default 1 check (revision > 0),
  -- null = shared across every agent; an agent id = private to that agent.
  agent_scope text null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz null,
  unique (key, agent_scope, revision)
);

-- Reading "the current value of key K for agent A" is the hot path.
create index if not exists preferences_current_idx
  on preferences (key, agent_scope)
  where superseded_at is null;

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  -- Insertion order. `created_at` comes from the run's injected clock, so two
  -- notes in one turn share a timestamp; "newest first" needs a tiebreak that
  -- does not depend on a random uuid.
  seq bigserial not null,
  content text not null,
  -- 'shared' or an agent id. Publishing to shared is explicit, never a default.
  scope text not null default 'shared',
  kind text not null check (kind in ('fact', 'observation', 'todo')),
  source_conversation_id uuid null,
  source_message_ref text null,
  created_by_agent text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz null,
  deleted_at timestamptz null
);

create index if not exists notes_scope_recent_idx on notes (scope, created_at desc, seq desc);
create index if not exists notes_live_idx on notes (created_at desc) where deleted_at is null;
create index if not exists notes_kind_idx on notes (kind, created_at desc);
