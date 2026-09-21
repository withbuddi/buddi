-- What the owner said while an agent was working, before it is part of the
-- conversation (docs/ideas/queued-input.md).
--
-- It cannot live in `core.messages` while it waits. A transcript is a strict
-- alternation the providers check: an assistant turn that calls a tool is
-- followed *immediately* by the user turn carrying that call's results, and a
-- row written in between — between the call and its result — makes the whole
-- history unreplayable. The owner's words arrive at exactly that moment, by
-- definition: mid-tool-call is what "while it was working" means.
--
-- So they wait here, durably, with a state of their own, and they join the
-- transcript only at the loop's safe point — inside the tool-results turn,
-- after the results — or, if the run ends before it takes them, as the next
-- turn. The state is the queue: an installation that restarts mid-run finds
-- its pending rows here and promotes them, rather than losing the message or
-- replaying it in a position the API refuses.
create table if not exists core.pending_input (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references core.conversations (id) on delete cascade,
  -- The run it was handed to, when there was one. Null means nobody had it:
  -- it is simply waiting for the next turn.
  run_id uuid null,
  text text not null,
  -- When the owner said it. Immutable: the canonical turn gets a time of its
  -- own when it is written, and this stays the record of when it arrived.
  received_at timestamptz not null default now(),
  -- pending  — waiting; nobody has it.
  -- leased   — handed to a run's next model step, not yet acknowledged.
  -- delivered— the model was shown it, and it is in the transcript.
  -- promoted — no run took it; it became a turn of its own.
  state text not null default 'pending' check (state in ('pending', 'leased', 'delivered', 'promoted')),
  delivered_at timestamptz null,
  -- The `core.messages` row that ended up carrying it, once one does.
  message_id uuid null references core.messages (id) on delete set null
);

-- The two questions ever asked of this table: "what is waiting in this
-- conversation?" and, at startup, "what is waiting anywhere?".
create index if not exists pending_input_waiting_idx
  on core.pending_input (conversation_id, received_at, id)
  where state in ('pending', 'leased');
