-- Files saved before the plugin host existed (docs/specs/plugin-host-api.md §6).
--
-- `ctx.buddi.files` shows a plugin the files it saved (core.plugin_files, 040)
-- and the files handed into its conversation. A file a plugin saved through
-- core's store before 040 has no row there, so the plugin that made it could
-- no longer see it. This attributes what the file's own provenance names, once,
-- and nothing it does not: re-running it adds nothing (on conflict do nothing).
--
-- What names the saver:
--   * the surface a plugin stamped on it — `email` (a fetched attachment) and
--     `host` (a file the host plugin returned); telegram and web are the
--     owner's uploads, not a plugin's;
--   * a plugin's own row pointing at it — an email draft's body
--     (email.drafts.artifact_id), when email's schema is there;
--   * the one shape the developer plugin gave its screenshots and nothing
--     else gives a file: a PNG an agent made, no surface, captioned
--     "<process> at <path> (port <n>), <w>×<h>".
--
-- Everything else stays unattributed: the owner's uploads, and what agents,
-- image and finance made with no mark of the plugin. The plugins that read
-- those (artifacts, host, image, finance) declare files:library and see the
-- whole library, so nothing they rely on is hidden.

insert into core.plugin_files (plugin, artifact_id, saved_at)
select a.source_surface, a.id, a.created_at
  from core.artifacts a
 where a.source_surface in ('email', 'host')
on conflict do nothing;

do $$
begin
  if to_regclass('email.drafts') is not null then
    execute $sql$
      insert into core.plugin_files (plugin, artifact_id, saved_at)
      select 'email', a.id, a.created_at
        from email.drafts d
        join core.artifacts a on a.id = d.artifact_id
      on conflict do nothing
    $sql$;
  end if;
end
$$;

insert into core.plugin_files (plugin, artifact_id, saved_at)
select 'developer', a.id, a.created_at
  from core.artifacts a
 where a.mime = 'image/png'
   and a.source_surface is null
   and a.created_by <> 'owner'
   and a.filename ~ '-[0-9]+-[^/]*\.png$'
   and a.caption ~ ' at .* \(port [0-9]+\), [0-9]+×[0-9]+$'
on conflict do nothing;
