-- Goals: a target with a clock, that buddi keeps.
--
-- A reminder is one instant; a mission is a standing schedule; a sentinel is a
-- watcher over somebody else's rows. A goal is the object none of them is: a
-- number to reach, a date to reach it by, an agent that holds it, and a rhythm
-- of checks that runs whether or not anyone is talking to buddi. Before this,
-- "help me cut my debt by 40k in six months" lived in one conversation and
-- died with it.
--
-- Two tables and one rule between them. `core.goals` is what the owner
-- approved — the target, the baseline the card showed them, the deadline, the
-- cadence — and it is written once and changed only through another approval.
-- `core.goal_checks` is what actually happened: one row per measurement, with
-- the arithmetic of that moment recorded beside the number. Nothing here
-- recomputes history; a check says what was true when it was taken, and the
-- projection it carries is the projection that was drawn then.
--
-- `value` is nullable on purpose. A metric can answer "I cannot measure this
-- right now" — no data yet, the plugin uninstalled, the bank not synced — and
-- the honest record of that is a check with no number and a note saying why,
-- not a made-up figure and not a missing row. A goal with seven days of those
-- is a fact the holder is woken about.
--
-- The 12-open-goal budget is not here: it is enforced in
-- `packages/core/src/goals/store.ts`, as a count in the INSERT's own WHERE
-- clause taken under a transaction-scoped advisory lock. The count alone is
-- not enough — under READ COMMITTED two racing statements both see eleven and
-- both commit — so the lock is what actually makes "one goal and one refusal"
-- true, and the count is what decides which.

create table if not exists core.goals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  -- The holder. A goal has one home: a different agent may read it, never hold
  -- it, and it never changes hands.
  agent_id text not null,
  -- The namespaced metric id, e.g. `finance.total_debt`. Deliberately not a
  -- foreign key to anything: metrics come from plugins, and a plugin the owner
  -- uninstalls must leave the goal standing and unmeasurable, not delete it.
  metric text not null,
  -- The narrowing handed to the metric's `measure`, validated against its own
  -- `params` schema at set time.
  params jsonb not null default '{}'::jsonb,
  -- 'absolute' is a number to land on; 'delta' is a move from the baseline
  -- ("down by 40000" is -40000), which is how an owner says it out loud.
  target_kind text not null check (target_kind in ('absolute', 'delta')),
  target_value numeric not null,
  -- Measured when the goal was set, and stored because it is what the owner
  -- saw on the card. Every progress figure is relative to this number, so
  -- re-measuring it later would quietly rewrite the past.
  baseline_value numeric not null,
  baseline_as_of timestamptz not null,
  deadline timestamptz not null,
  cadence text not null check (cadence in ('daily', 'weekly')),
  -- The currency of the first reading, when the metric answers one. It belongs
  -- to the *goal*, not to each check: a card that renders a target or a
  -- milestone has no check in its hand, and guessing dollars for a euro debt
  -- is worse than printing the bare number.
  currency text null,
  -- Numbers on the same scale as the target: deltas when the target is a
  -- delta, absolutes when it is absolute. Each fires once when crossed.
  milestones jsonb not null default '[]'::jsonb,
  state text not null default 'open'
    check (state in ('open', 'met', 'missed', 'closed')),
  closed_at timestamptz null,
  closed_note text null,
  created_at timestamptz not null default now(),
  -- Millisecond precision, deliberately: this column is the goal's *version*.
  -- `goal.update` carries the `updated_at` its approval card was drawn from
  -- into the UPDATE's WHERE clause, and that value makes a round trip through
  -- JavaScript, whose Date has milliseconds and nothing finer. At the default
  -- microsecond precision the comparison would never match and every approved
  -- update would refuse itself.
  updated_at timestamptz(3) not null default now()
);

-- The sentinel's query: every open goal, oldest first. Small table, but this
-- runs hourly forever.
create index if not exists goals_state_idx on core.goals (state, created_at);

-- `goal.status` and the holder's own list.
create index if not exists goals_agent_idx on core.goals (agent_id, state, created_at);

create table if not exists core.goal_checks (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references core.goals (id) on delete cascade,
  at timestamptz not null default now(),
  -- What the metric said its number was true *of*, when it said so. `at` is
  -- when buddi looked; this is when the world was that way, and they are not
  -- the same thing for a metric reading last Friday's statement. Null when the
  -- check took no number, or when the reading did not say.
  as_of timestamptz null,
  -- Null means "not measurable at that moment"; `note` says why.
  value numeric null,
  currency text null,
  note text null,
  -- The arithmetic as it stood at `at`. Null where there was not enough to
  -- compute one: on_track needs a projection, a projection needs two checks.
  on_track boolean null,
  pace_needed numeric null,
  projected numeric null
);

-- "The last four checks", which is what a wake prompt carries, what the
-- projection is drawn over and what decides whether a cadence is due.
create index if not exists goal_checks_goal_at_idx on core.goal_checks (goal_id, at desc);
