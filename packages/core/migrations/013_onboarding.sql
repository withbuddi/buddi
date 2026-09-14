-- First run: the owner's profile, and the state of the conversation that fills it in.
--
-- A new installation's first contact is a short conversation, not a form. The
-- agent conducts it; code decides only *when* it happens and records that it
-- did. That "when" is one row.
--
-- Two halves:
--
--  1. `core.owner` grows the three things the agents need to address a person
--     properly — what to call them, which day "today" is for them, and which
--     language to answer in. They are nullable because an installation that
--     never had the conversation must keep working exactly as it did.
--  2. `core.onboarding` is the state machine: pending -> in-progress -> done
--     (or skipped). One row, one owner. `steps_done` is a free-form set of
--     strings rather than columns, because which questions get asked is the
--     skill's business and skills change without a migration.
--
-- The nudge columns (`nudges_sent`, `last_nudge_at`, `unanswered`,
-- `quiet_until`) belong to the first-two-weeks arc that follows the interview.
-- They live here because they are the same fact — how far into settling in this
-- installation is — and a second table would have to be joined to answer it.

alter table core.owner add column if not exists preferred_name text;
alter table core.owner add column if not exists timezone text;
alter table core.owner add column if not exists language text;

create table if not exists core.onboarding (
  -- One installation, one owner, one row. The default makes every accessor a
  -- single-row upsert with no id to pass around.
  owner_id text primary key default 'owner',
  state text not null default 'pending'
    check (state in ('pending', 'in-progress', 'done', 'skipped')),
  started_at timestamptz not null default now(),
  -- Set once, by whichever surface finished it. Null while it is still running.
  completed_at timestamptz,
  -- Where the conversation happened: 'telegram', 'cli'. Provenance, never a lock.
  surface text,
  -- Steps the interview got through, as a JSON array of strings. Free-form:
  -- ONBOARDING_STEPS names the canonical four and nothing enforces the order.
  steps_done jsonb not null default '[]'::jsonb,
  -- The nudge budget for the first-two-weeks arc.
  nudges_sent int not null default 0,
  last_nudge_at timestamptz,
  -- Consecutive nudges the owner did not answer. Reset when they speak.
  unanswered int not null default 0,
  -- `/quiet`: no nudge before this instant.
  quiet_until timestamptz,
  updated_at timestamptz not null default now()
);

-- This installation is long past its first run.
--
-- An owner row only exists because a surface already paired somebody and
-- answered them, so "core.owner has a row at the moment 013 is applied" is
-- exactly the set of installations that were talking before this shipped. A
-- fresh clone migrates with an empty core.owner, inserts nothing here, and
-- meets its agent on first contact as intended.
insert into core.onboarding (owner_id, state, started_at, completed_at, surface)
select id, 'done', now(), now(), 'pre-existing'
  from core.owner
on conflict (owner_id) do nothing;
