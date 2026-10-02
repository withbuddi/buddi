-- Alerts: decisions, not chores (docs/architecture.md, "Sentinels").
--
-- A finding carries two texts from now on: the owner's line (plain, short,
-- what happened and why it matters — the only words any surface shows him)
-- and the agent brief, which stays in `detail` and is read only by the agent
-- that "Ask about it" or a wake hands the finding to. The rest is what makes a
-- finding a decision instead of a chore:
--
--   kind        what sort of fact it is within its watcher; findings of the
--               same watcher and kind are drawn as one row.
--   subject     what it is about ({ id, label }: an account, a sender), the
--               row inside a group and what "Stop telling me this" silences.
--   group_spec  how a group of this kind reads ({ title, ownerLine? }, with
--               `{count}` in either).
--   actions     what the owner can do about it, the first one primary.
--   agent_id    the agent that answers for it, so "Ask" reaches the same one
--               a wake would.
--   snoozed_until  "Not now": quiet until then. `snoozed_at` without it is
--               the old snooze, quiet until the fact changes ("Not needed").
alter table core.sentinel_findings
  add column if not exists owner_line text,
  add column if not exists kind text not null default '',
  add column if not exists subject jsonb,
  add column if not exists group_spec jsonb,
  add column if not exists actions jsonb not null default '[]'::jsonb,
  add column if not exists agent_id text,
  add column if not exists snoozed_until timestamptz;

-- The recap reads the owner's line too.
alter table core.digest_items add column if not exists owner_line text;

-- "Stop telling me this": one row per silenced subject, or per whole kind
-- when subject_id is ''. A finding a mute covers never fires, never reaches
-- the recap and is not listed; the watcher keeps running, so taking the mute
-- back (Settings → Watchers) shows what is still true at once.
create table if not exists core.sentinel_mutes (
  id uuid primary key default gen_random_uuid(),
  sentinel_id text not null,
  kind text not null default '',
  subject_id text not null default '',
  -- What the owner read when he chose it, kept for the Settings list.
  label text not null,
  created_at timestamptz not null default now(),
  unique (sentinel_id, kind, subject_id)
);
