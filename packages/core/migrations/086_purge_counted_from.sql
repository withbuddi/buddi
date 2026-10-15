-- The month before a deleted file is purged counts from here for what was
-- deleted before (docs/files.md, "Deleting").
--
-- Until 083 nothing was ever purged: a tombstoned row (a discarded upload, an
-- unsent one the orphan sweep took) stayed and could be brought back. With the
-- purge, the first sweep after upgrading would remove every row tombstoned more
-- than thirty days earlier at once, with no month to restore it. So the purge
-- counts a row's month from whichever is later: its delete, or this upgrade.
create table if not exists core.artifact_purge_epoch (
  only_row boolean primary key default true check (only_row),
  counted_from timestamptz not null default now()
);

insert into core.artifact_purge_epoch (only_row) values (true) on conflict do nothing;
