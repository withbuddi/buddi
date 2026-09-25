-- Actions, approvals and the effect ledger — the authorization boundary.
--
-- docs/architecture.md, "Actions and approvals": nothing at tier `gated` executes
-- without an approval bound to an *immutable action object created before the
-- approval request*. The three tables here are that machinery:
--
--   core.actions          the immutable object: tool + version, canonical
--                         arguments, the full effect envelope the tool itself
--                         rendered, the preview shown to the owner, the hash
--                         the execution path rechecks, an expiry, and the
--                         policy version in force when it was created.
--   core.approvals        the state machine over one action, exactly one row:
--                         pending -> approved -> executing -> succeeded |
--                         failed | unknown, plus rejected / expired.
--   core.effect_attempts  the generic effect ledger: the envelope hash is
--                         written *before* dispatch, so an ambiguous
--                         completion is recorded as `unknown` and reviewed,
--                         never silently retried (exactly-once does not exist
--                         at the wire).
--
-- Nothing here is tool-specific: SMTP is the ledger's first user, deploy and
-- every later irreversible tool reuse it unchanged.

create table if not exists core.actions (
  id uuid primary key default gen_random_uuid(),
  -- The tool implementation and *its plugin's version*: an approval is bound to
  -- the code that will run, not to a name that might mean something else later.
  tool text not null,
  tool_version text not null,
  agent_id text not null,
  conversation_id uuid null references core.conversations (id) on delete set null,
  -- The job whose run is suspended waiting for this decision, when there is one.
  -- No foreign key: the queue is another module's table, and an action outlives
  -- the job that proposed it.
  job_id uuid null,
  -- Arguments as the registry validated them, canonically ordered.
  canonical_args jsonb not null,
  -- The full effect envelope the tool described: every SMTP recipient (BCC
  -- included), body, attachment hashes — whatever "what will actually happen"
  -- means for this tool. The preview is rendered from this, never from
  -- model-written text.
  envelope jsonb not null,
  -- sha256 over (tool, tool_version, canonical_args). Any meaningful edit
  -- invalidates the approval, because execution rechecks this.
  args_hash text not null,
  preview text not null,
  expires_at timestamptz not null,
  policy_version int not null,
  created_at timestamptz not null default now()
);

create index if not exists actions_created_idx on core.actions (created_at desc);
create index if not exists actions_job_idx on core.actions (job_id) where job_id is not null;

create table if not exists core.approvals (
  action_id uuid primary key references core.actions (id) on delete cascade,
  state text not null
    check (state in ('pending', 'approved', 'rejected', 'expired', 'executing',
                     'succeeded', 'failed', 'unknown')),
  -- The owner identity that decided, and the surface it came from
  -- ('telegram', 'cli'). A plain "yes" in a chat resolves nothing: only a
  -- callback naming this action does.
  decided_by text null,
  decided_via text null,
  decided_at timestamptz null,
  -- The executor that atomically claimed the approved action. Exactly one wins.
  claimed_by text null,
  claimed_at timestamptz null,
  -- What execution produced: the result, or the error, persisted separately
  -- from the decision.
  outcome jsonb null,
  updated_at timestamptz not null default now()
);

create index if not exists approvals_pending_idx
  on core.approvals (updated_at)
  where state = 'pending';

create table if not exists core.effect_attempts (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references core.actions (id) on delete cascade,
  attempt int not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  state text not null check (state in ('executing', 'succeeded', 'failed', 'unknown')),
  -- The envelope exactly as it stood at dispatch. Recorded before the effect
  -- leaves the machine, so a crash mid-flight still leaves evidence of intent.
  envelope_hash text not null,
  result jsonb null,
  error text null
);

create unique index if not exists effect_attempts_action_attempt_idx
  on core.effect_attempts (action_id, attempt);

create index if not exists effect_attempts_unknown_idx
  on core.effect_attempts (started_at)
  where state = 'unknown';
