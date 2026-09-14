-- Pairing by one-time code, and what a paired device is (roadmap: devices).
--
-- Until now the only way to become the owner's device was an environment
-- variable: `TELEGRAM_OWNER_USER_ID`, read at startup. That works for the
-- machine that runs buddi and for nobody else — a second phone, a laptop, a
-- reinstall all mean editing `.env` and restarting.
--
-- A pairing code is the same decision made at runtime and still made by the
-- owner: the code is minted on the owner's own machine (the CLI), it is short
-- lived, it is single use, and consuming it is one atomic UPDATE, so two people
-- racing the same code cannot both win. Nothing here weakens the rule that a
-- surface never decides who the owner is: it hands core a code and core answers.

create table if not exists core.pairing_codes (
  code text primary key,
  surface text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Stamped by the one UPDATE that claims the code. Null means unclaimed.
  used_at timestamptz,
  -- The identity the code created, kept for the audit trail. `set null` on
  -- delete: unpairing a device must not erase the record that a code was used.
  used_by_identity uuid references core.surface_identities (id) on delete set null
);

-- Housekeeping and "which codes are outstanding for this surface".
create index if not exists pairing_codes_surface_idx
  on core.pairing_codes (surface, expires_at desc);

-- What a paired identity is, beyond its numeric ids: a name the owner
-- recognizes, when it was paired, when it last spoke, and how it got here.
alter table core.surface_identities
  add column if not exists label text,
  add column if not exists paired_at timestamptz not null default now(),
  add column if not exists last_seen_at timestamptz,
  add column if not exists paired_via text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'surface_identities_paired_via_check'
  ) then
    alter table core.surface_identities
      add constraint surface_identities_paired_via_check
      check (paired_via is null or paired_via in ('env', 'code', 'manual'));
  end if;
end
$$;

-- Every identity that existed before this migration got here one way: the
-- environment allowlist read at startup. Say so, rather than leaving it unknown
-- — and date the pairing from when the row was written, not from when this
-- migration happened to run.
update core.surface_identities
   set paired_via = 'env',
       paired_at = created_at
 where paired_via is null;
