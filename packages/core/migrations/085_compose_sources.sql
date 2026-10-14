-- The program a composed version was made from (docs/files.md, "Composed documents").
--
-- An agent's `artifacts.compose` writes a small program against a document
-- library; buddi runs it confined and the bytes become the file's next
-- version. The program travels beside that version, not on it: one row per
-- version compose produced, none for the owner's versions (a save in Word,
-- Open in app, the Canvas), so `core.artifacts` stays lean and the row goes
-- with its version when the purge removes it. A Restore copies the row with
-- the bytes.
create table if not exists core.compose_sources (
  artifact_id uuid primary key references core.artifacts (id) on delete cascade,
  kind text not null check (kind in ('docx', 'pptx', 'xlsx')),
  -- The library the program was written against and the versions it ran under.
  library text not null,
  library_version text not null,
  node_version text not null,
  program text not null check (octet_length(program) <= 204800),
  created_at timestamptz not null default now()
);
