-- Offered actions: the small set of things a report hands the owner to do.
--
-- Until now a report was prose and nothing else. The owner read "Dorothée has
-- retired and named two successors" and then had to go and *be* the person who
-- does something about it — open Gmail, find the thread, write the reply. The
-- agent knew perfectly well what the two or three sensible next moves were and
-- had nowhere to put them.
--
-- An offer is that: a label the owner reads and a prompt the agent wrote for
-- its own future self. Tapping one enqueues an ordinary agent run with that
-- prompt. Which is the whole safety story, and why this table is so thin:
--
--  * An offer **authorizes nothing**. It is a shortcut for typing a sentence
--    the owner could have typed. Every tier still applies to the run it starts;
--    an effect that needed an approval before still needs one, with the same
--    preview and the same buttons. There is no second path to sending mail.
--  * An offer is **agent-written**, never lifted from a message. The persona
--    holds that line; the length cap here holds the rest.
--  * An offer is **claimed once**. `taken_at` is set by an atomic update, so a
--    double tap — two surfaces, or an impatient thumb — starts one run.
--  * An offer **expires**. A button still sitting in a chat next week should
--    not start a run about a mail that was dealt with on Tuesday.
--
-- Nothing here is mail-specific: any agent's report can offer actions, and the
-- dashboard and Telegram render the same rows.

create table if not exists core.offers (
  id uuid primary key default gen_random_uuid(),
  -- The agent that offered it, and the agent woken if it is taken. An offer
  -- never changes hands: it cannot name its way into another agent's tools.
  agent_id text not null,
  -- The run that offered it. Provenance only — taking one starts a fresh
  -- conversation, the same way a reminder does.
  conversation_id uuid null references core.conversations (id) on delete set null,
  -- What the owner reads on the button or the chip.
  label text not null,
  -- What the agent is asked when the owner takes it. Written by the agent, in
  -- the owner's voice; it is a request, never an authorization.
  prompt text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set by the atomic claim. Null means still offered.
  taken_at timestamptz null,
  -- Which surface the tap came from ('telegram', 'web'). Recorded, never trusted.
  taken_via text null,
  -- The run the tap started, once there is one.
  taken_job_id uuid null
);

-- What a surface lists: still offered, not expired, newest first.
create index if not exists offers_open_idx on core.offers (created_at desc)
  where taken_at is null;

-- Per-report grouping, so a set of offers can be rendered and retired together.
create index if not exists offers_conversation_idx on core.offers (conversation_id);
