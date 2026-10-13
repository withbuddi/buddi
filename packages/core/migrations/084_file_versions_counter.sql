-- Version numbers are never reused (docs/files.md, "Versions").
--
-- 083 numbered a file's next version one past the highest row it had, so a
-- deleted newest version purged a month later gave its number to the next
-- save, and an editor still holding that number as its base could save over
-- unrelated content. The file now keeps its own counter, raised under the
-- file's lock by every version written.
alter table core.files add column if not exists next_version integer not null default 1;

update core.files f
   set next_version = coalesce((select max(a.version) from core.artifacts a where a.file_id = f.id), 0) + 1;

-- A row inserted with no file is version 1 of a new file, whose next is 2.
create or replace function core.artifact_default_file() returns trigger
language plpgsql as $$
begin
  if new.file_id is null then
    insert into core.files (conversation_id, name, mime, created_by, origin, created_at, next_version)
    values (new.conversation_id, new.filename, new.mime, new.created_by, 'upload', coalesce(new.created_at, now()), 2)
    returning id into new.file_id;
    new.version := coalesce(new.version, 1);
  end if;
  return new;
end;
$$;

-- Whoever writes a version, the counter moves past it.
create or replace function core.artifact_bump_version() returns trigger
language plpgsql as $$
begin
  update core.files set next_version = greatest(next_version, new.version + 1) where id = new.file_id;
  return new;
end;
$$;

drop trigger if exists artifacts_bump_version on core.artifacts;
create trigger artifacts_bump_version after insert on core.artifacts
  for each row execute function core.artifact_bump_version();

-- Which version of a file an agent last read (artifacts.text, artifacts.describe,
-- a plugin's files.read): once it has read the owner's newest version, the
-- turn's note about that version is not said again.
create table if not exists core.file_reads (
  file_id uuid not null references core.files (id) on delete cascade,
  agent_id text not null,
  version integer not null,
  read_at timestamptz not null default now(),
  primary key (file_id, agent_id)
);
