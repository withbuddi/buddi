-- People: a structured kind of memory (docs/memory.md, "People").
--
-- One row per person the owner knows: who they are to the owner, how to
-- address them, their yearly dates (day and month, the year optional) and a
-- few notes. Every agent reads them as compact context; the owner edits them
-- in Settings → Memory → People. An agent writes one with `memory.person`,
-- straight away only when the owner said it in that very turn, else as a
-- proposal the owner keeps. Forgetting is a soft delete, like a note.
--
-- Like the rest of memory: context, never permission.

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  relationship text null,
  address_as text null,
  birthday_day smallint null check (birthday_day between 1 and 31),
  birthday_month smallint null check (birthday_month between 1 and 12),
  birthday_year smallint null check (birthday_year between 1900 and 2100),
  anniversary_day smallint null check (anniversary_day between 1 and 31),
  anniversary_month smallint null check (anniversary_month between 1 and 12),
  anniversary_year smallint null check (anniversary_year between 1900 and 2100),
  notes text null,
  -- 'owner' (Settings, or a kept proposal) or the agent that wrote it.
  created_by text not null,
  source_conversation_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

-- One live person per name, whatever the case: "marion" and "Marion" are one.
create unique index if not exists people_live_name_idx on people (lower(name)) where deleted_at is null;

-- One-time steps this plugin has taken (the seed from existing notes).
create table if not exists meta (
  key text primary key,
  value text null,
  at timestamptz not null default now()
);
