-- Metrics the owner reports (docs/goals.md, "Metrics the owner reports").
--
-- A goal needs a number, and until now only plugins answered one. "288 to 220
-- by December" has no plugin behind it: the owner is the sensor. These two
-- tables are that sensor's record — a metric core keeps, and the values the
-- owner told buddi — so a weight goal gets the same pace, drift and milestones
-- as a debt goal.
--
-- `core.owner_metrics` is the definition, created on the fly when a goal names
-- a quantity no plugin measures. The goal's `metric` is `owner.<slug>`; the
-- slug is kebab, unique per installation, and is what a later value names.
--
-- `core.owner_metric_values` is append-only: one row per thing the owner said.
-- `at` is when buddi wrote it down, `as_of` when it was true ("285 this
-- morning", said at noon). Nothing here is ever rewritten; a wrong number is
-- corrected by saying the right one, which is newer.

create table if not exists core.owner_metrics (
  slug text primary key
    check (slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(slug) <= 40),
  label text not null,
  unit text not null check (unit in ('number', 'currency', 'percent', 'count', 'minutes')),
  -- A free word for what the number is counted in ("lb", "kg", "km"). The unit
  -- stays the enum every surface already formats; this is only the suffix.
  unit_label text null,
  direction text not null check (direction in ('down', 'up')),
  created_at timestamptz not null default now()
);

create table if not exists core.owner_metric_values (
  id uuid primary key default gen_random_uuid(),
  slug text not null references core.owner_metrics (slug) on delete cascade,
  at timestamptz not null default now(),
  as_of timestamptz not null,
  value numeric not null,
  note text null,
  -- Where the owner said it: a dashboard or terminal chat, Telegram, or
  -- anything else (a script, the MCP server).
  source text not null check (source in ('chat', 'telegram', 'api')),
  conversation_id uuid null
);

-- "The latest value" and "the values in this window", both by slug.
create index if not exists owner_metric_values_slug_as_of_idx
  on core.owner_metric_values (slug, as_of desc, at desc);
