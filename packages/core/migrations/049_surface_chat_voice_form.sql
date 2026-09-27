-- Voice replies on a chat surface, in two halves (docs/telegram.md, Voice):
-- *when* an answer is spoken (`voice_when`: 'spoken', the default, 'always'
-- or 'off' — the old `voice` column, same values, same meaning) and *what*
-- is sent (`voice_form`: 'voice', the note alone, or 'both', the note with
-- the text as its caption). Text only is `voice_when = 'off'`.
alter table core.surface_chat_voice rename column voice to voice_when;
alter table core.surface_chat_voice
  add column voice_form text not null default 'voice' check (voice_form in ('voice', 'both'));
