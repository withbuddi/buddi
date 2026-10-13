-- Files as rows (docs/files.md, "Versions").
--
-- Until now a file was inferred from artifact rows: by its workspace path,
-- else by its name less a "(vN)" mark, its type and its author, and the
-- owner's edits rewrote rows in place with a side table saying so. From here
-- a file is one row in core.files, and every row of core.artifacts is one of
-- its versions, numbered, appended and never rewritten: `created_by` is the
-- author of that version (the owner for his saves and restores), and what a
-- file is — its name, its conversation, the workspace path a command's
-- output came from and who that workspace belongs to — lives on the file.
--
-- The backfill groups the existing rows once by the rule the code used
-- (store.ts `fileChainKeySql`, removed with this migration), deleted rows
-- included, so a version the owner deleted is still a version of its file.

create table if not exists core.files (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid null references core.conversations (id) on delete set null,
  -- Never carries a version mark; a download adds " (vN)".
  name text null,
  mime text not null,
  -- Who made the file: 'owner' or an agent (or plugin) id. A command's
  -- output belongs to this agent's workspace in this conversation.
  created_by text not null,
  -- 'document': written by title (artifacts.write); 'capture': a command's
  -- output, read from a workspace; 'upload': anything else handed in or saved.
  origin text not null check (origin in ('document', 'capture', 'upload')),
  -- A capture's path relative to BUDDI_DATA_DIR, and the copy's hash as buddi
  -- last read or wrote it: the owner's save writes back there while it holds it.
  origin_path text null,
  origin_sha256 text null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index if not exists files_conversation_name_idx on core.files (conversation_id, lower(name));
create index if not exists files_origin_path_idx on core.files (conversation_id, origin_path) where origin_path is not null;
create index if not exists files_deleted_idx on core.files (deleted_at) where deleted_at is not null;

alter table core.artifacts add column if not exists file_id uuid null references core.files (id) on delete cascade;
alter table core.artifacts add column if not exists version integer null;
-- A Restore: the version whose bytes this one copies.
alter table core.artifacts add column if not exists restored_from integer null;

-- The rule the rows were grouped by, once.
create temporary table file_chain_083 on commit drop as
select a.id,
  (case
    when a.conversation_id is null or a.filename is null then a.id::text
    when a.origin_path is not null then 'o:' || a.conversation_id::text || ':' || a.origin_path
    when (select count(distinct o.origin_path) from core.artifacts o
           where o.conversation_id = a.conversation_id and o.created_by = a.created_by and o.origin_path is not null and o.deleted_at is null
             and regexp_replace(lower(regexp_replace(regexp_replace(o.origin_path, '^.*/', ''), ' \(v[0-9]+\)(\.[^.]+)$', '\1', 'i')), '[[:space:]_-]+', '-', 'g')
               = regexp_replace(lower(regexp_replace(a.filename, ' \(v[0-9]+\)(\.[^.]+)$', '\1', 'i')), '[[:space:]_-]+', '-', 'g')) = 1
      then 'o:' || a.conversation_id::text || ':' || (select min(o.origin_path) from core.artifacts o
           where o.conversation_id = a.conversation_id and o.created_by = a.created_by and o.origin_path is not null and o.deleted_at is null
             and regexp_replace(lower(regexp_replace(regexp_replace(o.origin_path, '^.*/', ''), ' \(v[0-9]+\)(\.[^.]+)$', '\1', 'i')), '[[:space:]_-]+', '-', 'g')
               = regexp_replace(lower(regexp_replace(a.filename, ' \(v[0-9]+\)(\.[^.]+)$', '\1', 'i')), '[[:space:]_-]+', '-', 'g'))
    else 'n:' || a.conversation_id::text || ':' || a.mime || ':' || a.created_by || ':'
      || regexp_replace(lower(regexp_replace(a.filename, ' \(v[0-9]+\)(\.[^.]+)$', '\1', 'i')), '[[:space:]_-]+', '-', 'g')
  end) as chain
from core.artifacts a
where a.file_id is null;

create temporary table file_map_083 on commit drop as
select chain, gen_random_uuid() as file_id from (select distinct chain from file_chain_083) c;

insert into core.files (id, conversation_id, name, mime, created_by, origin, origin_path, origin_sha256, created_at, deleted_at)
select m.file_id,
       newest.conversation_id,
       regexp_replace(newest.filename, ' \(v[0-9]+\)(\.[^.]+)$', '\1', 'i'),
       newest.mime,
       first.created_by,
       case
         when capture.origin_path is not null then 'capture'
         when first.created_by = 'owner' or first.source_surface is not null then 'upload'
         else 'document'
       end,
       capture.origin_path,
       capture.origin_sha256,
       first.created_at,
       case when gone.all_deleted then gone.last_deleted end
  from file_map_083 m
  -- The name and type of the newest live version (else the newest at all).
  cross join lateral (
    select a.* from core.artifacts a join file_chain_083 c on c.id = a.id
     where c.chain = m.chain
     order by (a.deleted_at is null) desc, a.created_at desc, a.id desc limit 1
  ) newest
  -- Who made the file: its first version's author.
  cross join lateral (
    select a.* from core.artifacts a join file_chain_083 c on c.id = a.id
     where c.chain = m.chain
     order by a.created_at asc, a.id asc limit 1
  ) first
  left join lateral (
    select a.origin_path, a.origin_sha256 from core.artifacts a join file_chain_083 c on c.id = a.id
     where c.chain = m.chain and a.origin_path is not null
     order by (a.deleted_at is null) desc, a.created_at desc, a.id desc limit 1
  ) capture on true
  cross join lateral (
    select bool_and(a.deleted_at is not null) as all_deleted, max(a.deleted_at) as last_deleted
      from core.artifacts a join file_chain_083 c on c.id = a.id
     where c.chain = m.chain
  ) gone;

-- Versions numbered in the order they were written; deleted ones keep their number.
update core.artifacts a
   set file_id = v.file_id, version = v.version
  from (
    select c.id, m.file_id,
           row_number() over (partition by c.chain order by a.created_at asc, a.id asc)::int as version
      from file_chain_083 c
      join file_map_083 m on m.chain = c.chain
      join core.artifacts a on a.id = c.id
  ) v
 where a.id = v.id;

-- A version the owner edited in place holds his bytes: it is his.
update core.artifacts a set created_by = 'owner'
 where exists (select 1 from core.owner_file_edits e where e.artifact_id = a.id);

-- No version mark in a stored name: every version carries its file's name.
update core.artifacts a set filename = f.name
  from core.files f
 where f.id = a.file_id and a.filename is distinct from f.name;

alter table core.artifacts alter column file_id set not null;
alter table core.artifacts alter column version set not null;
create unique index if not exists artifacts_file_version_key on core.artifacts (file_id, version);

/*
 * A row inserted with no file (a direct insert: a script, an older plugin)
 * is a file of its own, version 1. The store always names the file.
 */
create or replace function core.artifact_default_file() returns trigger
language plpgsql as $$
begin
  if new.file_id is null then
    insert into core.files (conversation_id, name, mime, created_by, origin, created_at)
    values (new.conversation_id, new.filename, new.mime, new.created_by, 'upload', coalesce(new.created_at, now()))
    returning id into new.file_id;
    new.version := coalesce(new.version, 1);
  end if;
  return new;
end;
$$;

drop trigger if exists artifacts_default_file on core.artifacts;
create trigger artifacts_default_file before insert on core.artifacts
  for each row execute function core.artifact_default_file();

-- Version identity is (file_id, version); bytes may repeat (a Restore, the
-- same output twice). Dedup of a re-sent attachment is the store's, under a lock.
drop index if exists core.artifacts_source_sha_origin_key;
alter table core.artifacts drop constraint if exists artifacts_source_sha_key;

-- What the side table and the per-row origin said now lives on the file and its versions.
drop table if exists core.owner_file_edits;
alter table core.artifacts drop column if exists origin_path;
alter table core.artifacts drop column if exists origin_sha256;
