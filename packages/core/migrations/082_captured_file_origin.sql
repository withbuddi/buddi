-- The workspace copy's hash as buddi last read or wrote it: the owner's save
-- writes back only while the copy still holds it (a command did not change it).
alter table core.artifacts add column if not exists origin_sha256 text null;

-- A captured file is known by where it came from as well as by its bytes:
-- the same bytes from two outputs are two files, each written back to its
-- own path. The bytes on disk are shared either way (content-addressed).
alter table core.artifacts drop constraint if exists artifacts_source_sha_key;
create unique index if not exists artifacts_source_sha_origin_key
  on core.artifacts (sha256, source_surface, source_chat_id, (coalesce(origin_path, '')));
