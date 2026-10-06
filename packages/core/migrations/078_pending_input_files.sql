-- Files the owner sent while an agent was working (queued input, 032).
--
-- The ids only: the bytes are hydrated when a run takes the row between two
-- tool calls, or when it is promoted into a turn of its own, exactly as an
-- ordinary turn's files are. A message may be files alone, so `text` may be
-- empty when this is not.
alter table core.pending_input
  add column if not exists attachment_ids uuid[] not null default '{}';
