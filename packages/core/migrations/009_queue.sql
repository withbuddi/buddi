-- The durable job queue (ARCHITECTURE.md, "Queue, concurrency, recovery" —
-- Phase 1, not Phase 2).
--
-- Even a single owner overlaps: a Telegram message, a mail ingest, a retry and
-- startup recovery all want to run at once. The queue is the one place where
-- that overlap is made safe, and every guarantee it offers is a *column*, not a
-- convention:
--
--   state          the only lifecycle. 'leased' is the sole running state, and
--                  it is always paired with an owner and an expiry.
--   lease_owner    who holds it, and lease_until when the hold expires. A
--                  worker that dies takes nothing with it: the lease lapses and
--                  `releaseStaleLeases` puts the job back (startup recovery).
--   attempts       incremented on *claim*, so a crash loop is bounded by
--                  max_attempts whether or not the worker ever reported.
--   run_after      when the job may next be claimed — the backoff clock.
--   dedup_key      unique. Enqueueing the same fact twice is a no-op, which is
--                  what lets the scheduler enqueue blindly per occurrence.
--   suspended      a run waiting for an approval holds no worker and no
--                  transaction. It is a row, and it is resumed by one.
--
-- core.system_flags carries the global pause control. It is read inside the
-- claim statement itself, so pausing takes effect for every worker at once
-- without any of them being told.

create table if not exists core.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending'
    check (state in ('pending', 'leased', 'succeeded', 'failed', 'suspended', 'cancelled')),
  priority int not null default 0,
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 3,
  lease_owner text null,
  lease_until timestamptz null,
  last_error text null,
  result jsonb null,
  conversation_id uuid null references core.conversations (id) on delete set null,
  dedup_key text null unique,
  suspended_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The claim path: state first, then the two things that order a ready job.
create index if not exists jobs_claimable_idx
  on core.jobs (state, run_after, priority);

-- Lease sweeping and the inspection path (`buddi jobs`).
create index if not exists jobs_lease_idx on core.jobs (lease_until)
  where state = 'leased';

create index if not exists jobs_kind_idx on core.jobs (kind, created_at desc);

create table if not exists core.system_flags (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Global pause exists from day one; the default is "running".
insert into core.system_flags (key, value)
values ('paused', 'false'::jsonb)
on conflict (key) do nothing;
