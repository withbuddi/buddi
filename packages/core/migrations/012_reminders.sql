-- Reminders: a one-off nudge an agent promised the owner.
--
-- A mission is a standing schedule; a sentinel is a deterministic watcher. A
-- reminder is neither: it is "tell me about this once, then forget it", the
-- thing an agent could not do at all before — it had to either invent a cron
-- or say no.
--
-- The row is deliberately thin. It carries *when*, *what was promised* and the
-- agent that promised it; it carries no verdict, because by the time it fires
-- the fact may have changed. Firing enqueues a normal agent run whose prompt
-- says: check first, then speak or stay silent. So a reminder is an instruction
-- to *look*, never a message queued for delivery.
--
-- States: pending -> fired | cancelled | expired. `expired` is the honest name
-- for a reminder the machine slept through: a nudge 30 hours late is worse
-- than no nudge, so it is closed out rather than delivered (see
-- REMINDER_GRACE_MS in packages/core/src/reminders).

create table if not exists core.reminders (
  id uuid primary key default gen_random_uuid(),
  -- The agent that promised it. It is also the agent woken when it fires:
  -- a reminder never changes hands.
  agent_id text not null,
  -- Where it was promised, when that is known. Provenance only — the run that
  -- fires starts a fresh conversation, so nothing here reopens an old thread.
  conversation_id uuid null references core.conversations (id) on delete set null,
  due_at timestamptz not null,
  text text not null,
  -- Structured evidence the agent wanted its future self to have (an account,
  -- an amount, a statement id). Handed back verbatim; never instructions.
  context jsonb null,
  state text not null default 'pending'
    check (state in ('pending', 'fired', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  fired_at timestamptz null,
  cancelled_at timestamptz null,
  cancel_reason text null
);

-- The firing loop's only query: pending rows whose instant has passed.
create index if not exists reminders_due_idx on core.reminders (state, due_at);

-- Per-agent listing (`reminder.list`, `buddi reminders --agent x`).
create index if not exists reminders_agent_idx on core.reminders (agent_id, due_at);
