-- Agent pictures: the image an owner uploaded for an agent (ROADMAP "Agent avatar").
--
-- Kept here, in the database, and never beside the agent file: the file is the
-- agent's definition and travels (Agent Father rewrites it, a plugin ships
-- one); a picture is the owner's, and goes wherever the database goes,
-- backups included. The icon in the file's `avatar` field stays the fallback.
--
-- `png` is what the gateway re-encoded, never the upload: a square PNG of at
-- most 512×512, so what is served here is pixels and nothing else.
-- `sha256` is of those bytes and is the served ETag.

create table if not exists core.agent_avatars (
  agent_id text primary key,
  png bytea not null,
  sha256 text not null,
  side integer not null check (side between 1 and 512),
  source text not null check (source in ('png', 'gif', 'svg')),
  updated_at timestamptz not null default now()
);
