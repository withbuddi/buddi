-- Artifacts: the store for files a mission builds or a surface hands in.
--
-- docs/architecture.md names artifacts a first-class core concept ("Data model"):
-- previewable from any surface, referable by approvals, and — with surface
-- attachment ingest — the landing place for a Telegram photo or PDF. Core owns
-- the table; the bytes live outside the database under BUDDI_DATA_DIR, so a
-- transcript row stays small and deletion stays possible.
--
-- Bytes are content-addressed (sha256) and never stored inline: core.messages
-- persists an artifact_ref block, never base64.

create table if not exists core.artifacts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('document', 'image', 'audio', 'other')),
  mime text not null,
  filename text null,
  size_bytes bigint not null,
  sha256 text not null,
  -- Relative to BUDDI_DATA_DIR, e.g. artifacts/2026/09/<sha256>.pdf. Relative on
  -- purpose: the data dir moves with the install, the rows do not.
  storage_path text not null,
  -- Where it came from, when a surface handed it in. Null for what an agent made.
  source_surface text null,
  source_chat_id text null,
  source_message_id text null,
  caption text null,
  -- 'owner' or an agent id.
  created_by text not null,
  conversation_id uuid null references core.conversations (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz null,
  -- The same file re-sent in the same chat is the same artifact, not a copy.
  -- Postgres treats NULLs as distinct here, so artifacts with no source are
  -- deduped in code (see saveArtifact) rather than pretended to be unique.
  constraint artifacts_source_sha_key unique (sha256, source_surface, source_chat_id)
);

create index if not exists artifacts_conversation_idx
  on core.artifacts (conversation_id, created_at desc);

create index if not exists artifacts_created_idx
  on core.artifacts (created_at desc);

create index if not exists artifacts_sha_idx on core.artifacts (sha256);
