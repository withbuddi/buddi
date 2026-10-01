-- The owner's places (docs/dashboard.md, Settings → Profile; docs/plugins.md
-- §9b, owner.places).
--
-- Home, Work and any other place the owner names, beside the timezone: a
-- label, the address as they typed it, what the geocoder matched it to (a
-- town, with its region and country), coordinates and the place's own zone.
-- Plugins that declare `owner:places` read them through ctx.buddi; nothing
-- here is written by a plugin.
create table if not exists core.owner_places (
  id text primary key,
  label text not null check (length(label) between 1 and 40),
  address text check (address is null or length(address) <= 200),
  place_name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  timezone text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists owner_places_label on core.owner_places (lower(label));

-- Places brought in once from somewhere they used to live (the weather
-- plugin's Home and Work). One row per source: present means done, so a place
-- the owner removes afterwards is not brought back at the next start.
create table if not exists core.owner_place_imports (
  source text primary key,
  imported integer not null default 0,
  at timestamptz not null default now()
);
