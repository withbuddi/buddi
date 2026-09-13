-- Scheduler: missions, schedule revisions, materialized occurrences.
--
-- The idempotency guarantee is the unique constraint on
-- (mission_id, schedule_revision, scheduled_at): materialization is a blind
-- `insert ... on conflict do nothing`, so replaying a catch-up window can never
-- produce a duplicate run. "Last occurrence materialized" (core.last_materialized)
-- is deliberately distinct from "last successful run" (core.occurrences.state).

create table if not exists core.missions (
  id text primary key,
  name text not null,
  agent_id text not null,
  prompt text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists core.schedule_specs (
  id uuid primary key default gen_random_uuid(),
  mission_id text not null references core.missions (id) on delete cascade,
  revision int not null,
  cron text not null,
  timezone text not null,
  misfire_policy text not null
    check (misfire_policy in ('replay-all', 'coalesce', 'latest-only', 'skip-after-deadline')),
  deadline_minutes int null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (mission_id, revision)
);

create index if not exists schedule_specs_active_idx
  on core.schedule_specs (mission_id, active);

create table if not exists core.occurrences (
  id uuid primary key default gen_random_uuid(),
  mission_id text not null references core.missions (id) on delete cascade,
  schedule_revision int not null,
  scheduled_at timestamptz not null,
  state text not null default 'pending'
    check (state in ('pending', 'claimed', 'succeeded', 'failed', 'skipped')),
  claimed_at timestamptz null,
  finished_at timestamptz null,
  run_conversation_id uuid null references core.conversations (id) on delete set null,
  error text null,
  created_at timestamptz not null default now(),
  unique (mission_id, schedule_revision, scheduled_at)
);

create index if not exists occurrences_claimable_idx
  on core.occurrences (state, scheduled_at);

create index if not exists occurrences_mission_idx
  on core.occurrences (mission_id, scheduled_at);

create table if not exists core.last_materialized (
  mission_id text primary key references core.missions (id) on delete cascade,
  through timestamptz not null
);
