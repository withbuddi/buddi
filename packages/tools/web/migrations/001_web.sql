-- web plugin schema (applied with search_path = web, public).
--
-- One table, and it is an audit log rather than a cache.
--
-- A cache would be the obvious thing to build and the wrong thing to build
-- first: it would make this plugin's answers stale in exactly the situation the
-- owner cares about (a price, today), and it would store pages strangers wrote
-- in the same database as his bank data.
--
-- What is actually worth keeping is the record of what his agents went and
-- looked at. This capability sends the owner's questions to a third party and
-- pulls back text from anywhere; the one thing that makes that reviewable after
-- the fact is a list of which agent asked what, when, where it went, and
-- whether the destination was refused. `blocked` rows are the interesting ones:
-- they are the record of something trying to reach a place it may not.
--
-- No page bodies. The log says where, never what came back: a fetch log is
-- small and dull, a page archive is a second copy of the internet inside the
-- owner's database.
create table if not exists fetches (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  -- 'search' or 'read'. Text, not an enum: a third kind should be a row, not a
  -- migration.
  kind text not null,
  -- Who asked. Null when a caller did not stamp the context (a CLI one-shot).
  agent_id text,
  conversation_id uuid,
  -- The query, for a search; the URL asked for, for a read.
  target text not null,
  -- The host actually reached, after redirects. Null when nothing was reached.
  host text,
  -- 'ok' | 'blocked' | 'error'
  outcome text not null,
  -- The short reason: 'private-address', 'too-large', 'not-found', …
  detail text,
  http_status integer,
  bytes integer
);

create index if not exists fetches_at_idx on fetches (at desc);
create index if not exists fetches_outcome_idx on fetches (outcome, at desc);
