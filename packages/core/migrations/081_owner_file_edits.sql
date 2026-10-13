-- The owner editing a file on the Canvas (docs/files.md, "Edited by you").
--
-- Where a captured file came from: a command's output is read from the
-- agent's workspace, and the owner's save writes back there, so the next
-- command works on his version. Relative to BUDDI_DATA_DIR, like
-- storage_path; null for everything that was not read from a workspace.
alter table core.artifacts add column if not exists origin_path text null;

-- Each save the owner made, so the agent is told once, on its next turn, and
-- a document write over an edit it has not read is refused.
create table if not exists core.owner_file_edits (
  id bigserial primary key,
  artifact_id uuid not null references core.artifacts (id) on delete cascade,
  conversation_id uuid null references core.conversations (id) on delete cascade,
  filename text null,
  edited_at timestamptz not null default now(),
  -- When a turn's context told the agent; null until then.
  noted_at timestamptz null
);

create index if not exists owner_file_edits_unnoted_idx
  on core.owner_file_edits (conversation_id) where noted_at is null;
create index if not exists owner_file_edits_artifact_idx
  on core.owner_file_edits (artifact_id);
