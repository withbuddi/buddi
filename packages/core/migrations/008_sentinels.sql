-- Sentinels: deterministic watchers that originate work without a model.
--
-- A sentinel is code, not a prompt: it runs on a fixed period, reads plugin
-- data, and returns findings keyed by a *stable* dedup key. Everything that
-- keeps the owner from being woken twice for the same fact lives in these
-- tables, not in an agent's judgement:
--
--   core.sentinel_findings   one row per key: when it was first and last seen,
--                            when it may fire again (cooldown_until), and when
--                            it stopped being true (resolved_at).
--   core.sentinel_runs       per sentinel: last run, and the last error — an
--                            error is recorded, never thrown away and never
--                            allowed to abort the tick.
--   core.digest_items        `info` findings wait here for the weekly recap
--                            instead of interrupting; consumed when delivered.
--
-- An `urgent` finding becomes a *pending occurrence* of the `sentinel-wake`
-- mission carrying the finding in `core.occurrences.payload` — the scheduler
-- path that already exists, so a wake is claimed, run and audited exactly like
-- a cron mission.

-- What a scheduled run carries beyond its instant. Null for cron occurrences.
alter table core.occurrences
  add column if not exists payload jsonb;

-- Notify policy: by default a scheduled run speaks only if the agent decided to
-- (mission.report). The weekly recap is the exception the owner asked for.
alter table core.missions
  add column if not exists always_deliver boolean not null default false;

create table if not exists core.sentinel_findings (
  -- The sentinel's own stable key, e.g. 'finance.floor-breach:2026-10-02'.
  key text primary key,
  sentinel_id text not null,
  severity text not null check (severity in ('urgent', 'info')),
  title text not null,
  detail text not null,
  data jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Set when the finding fires; until it passes, seeing the same key again is
  -- silence. Cleared on resolution so a fact that comes back can speak again.
  cooldown_until timestamptz,
  delivered_at timestamptz,
  resolved_at timestamptz
);

create index if not exists sentinel_findings_open_idx
  on core.sentinel_findings (sentinel_id)
  where resolved_at is null;

create table if not exists core.sentinel_runs (
  sentinel_id text primary key,
  last_run_at timestamptz not null default now(),
  last_error text
);

create table if not exists core.digest_items (
  id uuid primary key default gen_random_uuid(),
  finding_key text not null,
  severity text not null check (severity in ('urgent', 'info')),
  title text not null,
  detail text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- One unconsumed item per finding: a weekly digest lists a fact once.
create unique index if not exists digest_items_unconsumed_key_idx
  on core.digest_items (finding_key)
  where consumed_at is null;

create index if not exists digest_items_pending_idx
  on core.digest_items (created_at)
  where consumed_at is null;
