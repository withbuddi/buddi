-- Proposals: what an agent learned, waiting for the owner (docs/specs/learning.md).
--
-- An agent that rewrites its own instructions with nobody reading is drifting,
-- not improving. So everything learned arrives here first, as a proposal with
-- provenance, and nothing in this table changes anything: keeping one is the
-- owner's act, and applying it is the kind's own job (a skill file, a plugin's
-- policy, the agent file through Agent Father) — never this row's.
--
-- `provenance` is written by the gateway from the run, not by the model:
-- `{ agent, conversation, runId, turn, sources: [...] }`, where `sources` are
-- the untrusted inputs that were in the run's context when the proposal was
-- made (pages, mail, files, chat). `untrusted` is `sources` being non-empty,
-- kept as a column so the inbox can mark it without reading the json.
--
-- `fingerprint` is a stable hash of kind + agent + the payload's identifying
-- fields. A discarded proposal keeps it for 90 days, and a new proposal with
-- the same fingerprint in that window is refused; the store enforces the
-- window, the index makes the check cheap.

create table if not exists core.proposals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('skill', 'policy', 'change')),
  -- The agent that proposed it. For a `change`, also the agent it is about:
  -- an agent may only propose changes to its own file.
  agent text not null,
  -- The skill text, the policy, the diff. Replaced by the owner's corrected
  -- version when they keep an edited one.
  payload jsonb not null,
  provenance jsonb not null default '{}'::jsonb,
  untrusted boolean not null default false,
  state text not null default 'open'
    check (state in ('open', 'kept', 'discarded', 'expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz null,
  -- The owner's reason on a discard, or the sweep's line on an expiry.
  reason text null,
  fingerprint text not null,
  -- When the proposing agent was told, in a later run, that this was
  -- discarded. Told once: null until then.
  told_at timestamptz null
);

create index if not exists proposals_state_idx on core.proposals (state, created_at);
create index if not exists proposals_fingerprint_idx on core.proposals (fingerprint, state, decided_at);
create index if not exists proposals_agent_idx on core.proposals (agent, state);

-- One open proposal per fingerprint: the same skill proposed twice while the
-- first is still waiting is the same card, not two.
create unique index if not exists proposals_one_open_idx on core.proposals (fingerprint) where state = 'open';
