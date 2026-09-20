-- Recovery mode: this installation was restored from a backup and has not been
-- checked over yet.
--
-- The reason this is a table and not a flag in `core.system_flags`: a restore
-- brings back queued jobs, due missions, approvals nobody will answer any more
-- and standing permission grants that were given to an installation that no
-- longer exists. If the gateway simply started its loops, a machine restored on
-- Thursday would immediately act on Monday's world — send Monday's mail, run
-- Monday's missions — before the owner had said a word. So the loops stay off
-- until the owner has been through a checklist, and the checklist needs the
-- counts the dump carried, the archive it came from, and when it happened.
--
-- One row at most: `id` is a boolean with a check that pins it to true, which
-- is the smallest single-row constraint Postgres offers. "In recovery" is
-- `left_at is null`; leaving keeps the row so the history is not erased, and a
-- later restore overwrites it.
create table if not exists core.recovery (
  id boolean primary key default true check (id),
  restored_at timestamptz not null,
  archive text not null,
  buddi_version text,
  -- What the archive carried, counted at restore time: queued jobs, missions
  -- with a next occurrence, approvals awaiting an answer, paired Telegram
  -- chats. Counts, never rows — the rows are in their own tables.
  pending jsonb not null default '{}'::jsonb,
  left_at timestamptz
);
