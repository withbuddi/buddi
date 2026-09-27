-- Voice replies on a chat surface (docs/telegram.md, Voice): per chat, whether
-- an answer comes back as a voice note when the owner spoke ('spoken', the
-- default), always, or never. `fallback_noted_on` is the owner's day on which
-- the chat was last told why a reply came as text instead, so that line is
-- said at most once a day.
create table core.surface_chat_voice (
  surface text not null,
  external_chat_id text not null,
  voice text not null default 'spoken' check (voice in ('spoken', 'always', 'off')),
  fallback_noted_on date,
  updated_at timestamptz not null default now(),
  primary key (surface, external_chat_id)
);
