-- What a surface has been handed (gateway-owned, surface-shaped).
--
-- The artifact itself — bytes, hash, storage path — belongs to the artifact
-- store. These two tables hold only what a *chat* needs to know: which files
-- arrived here, and which one "this file" most likely refers to.
--
-- They are deliberately denormalized: /files answers from this table alone, so
-- listing a chat's recent files never depends on the artifact store's schema,
-- and an artifact that is later purged leaves a readable history behind.

create table if not exists core.surface_attachments (
  surface text not null,
  external_chat_id text not null,
  artifact_id text not null,
  -- The surface message the file arrived on; useful when tracing a run back.
  external_message_id text,
  filename text,
  kind text not null,
  mime text not null,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (surface, external_chat_id, artifact_id)
);

-- Recent first: /files reads the tail of one chat's history.
create index if not exists surface_attachments_recent_idx
  on core.surface_attachments (surface, external_chat_id, created_at desc);

-- The one file "import this statement" is about, per chat.
--
-- A pointer, not a log: exactly one row per chat, overwritten by each new file.
-- Recency is the whole contract — the surface only honours it for a short
-- window, so a stale row can never silently attach yesterday's receipt.
create table if not exists core.surface_last_attachment (
  surface text not null,
  external_chat_id text not null,
  artifact_id text not null,
  created_at timestamptz not null default now(),
  primary key (surface, external_chat_id)
);
