-- Reaching the owner (docs/notifications.md).
--
-- One row per thing buddi told, or will tell, the owner unasked. The row is
-- the record: where it went, when, whether it was seen and acted on. Routing
-- moves a row through `state` with one guarded UPDATE per step, so a tick that
-- runs twice moves nothing twice.
--
-- state:
--   shown    on the dashboard; `due_at` is when it goes to the channel anyway
--            if nobody has seen it
--   held     waiting for `due_at`: the end of the day for `today`, the end of
--            quiet hours for `now`
--   stored   kept for the record and the recap, never sent (`digest`, or a
--            kind the owner turned off)
--   sending  claimed by one delivery
--   sent     a channel took it
--   failed   no channel took it; `error` says why
create table if not exists core.owner_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('approval', 'question', 'watcher', 'reminder', 'failure', 'recap', 'plugin')),
  urgency text not null check (urgency in ('now', 'today', 'digest')),
  title text not null,
  text text,
  link text,
  offers jsonb not null default '[]'::jsonb,
  dedupe_key text,
  agent_id text,
  plugin_id text,
  -- The approval this row asks about: a channel that draws cards draws this one.
  action_id uuid,
  state text not null check (state in ('shown', 'held', 'stored', 'sending', 'sent', 'failed')),
  due_at timestamptz,
  channel text,
  -- How many times this key fired into this row, and whether the rate rule
  -- lowered it (the title then carries one sentence saying so).
  fired_count integer not null default 1,
  lowered boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  seen_at timestamptz,
  acted_at timestamptz,
  error text
);

create index if not exists owner_notifications_created on core.owner_notifications (created_at desc);
create index if not exists owner_notifications_due on core.owner_notifications (state, due_at)
  where state in ('shown', 'held');
create index if not exists owner_notifications_dedupe on core.owner_notifications (dedupe_key, created_at desc)
  where dedupe_key is not null;
create index if not exists owner_notifications_action on core.owner_notifications (action_id)
  where action_id is not null;

-- Where the owner is. One row per surface; "present" is active within two
-- minutes on any of them and not marked away since. Never sent anywhere.
create table if not exists core.owner_presence (
  surface text primary key,
  last_active_at timestamptz not null,
  away_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The few choices the Notifications page edits. One row at most; every value
-- has a default in code, so no row is a complete answer.
create table if not exists core.notification_settings (
  id boolean primary key default true check (id),
  -- A registered channel kind, or null for "the first one there is".
  default_channel text,
  -- kind -> channel kind, or 'off'. Approvals and questions cannot be off.
  per_kind jsonb not null default '{}'::jsonb,
  -- The owner's local clock, 'HH:MM'. Both or neither.
  quiet_start text,
  quiet_end text,
  -- When the day's held items go out as one message. Null is 18:00.
  end_of_day text,
  updated_at timestamptz not null default now()
);
