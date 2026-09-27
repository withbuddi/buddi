/**
 * Voice on Telegram (docs/telegram.md, Voice).
 *
 * In: a voice note is transcribed by the speech plugin's `speech.transcribe`,
 * shown back as a quote ("🎤 …"), then run as if the owner had typed it. Out:
 * when the owner spoke (or chose `/voice always`), the answer is synthesized
 * with `speech.say` and sent as a voice note with the text as its caption.
 *
 * buddi does not know the speech plugin: it calls the two tools **by name**
 * through the registry, as the owner (`OWNER_AGENT_ID`), so no approval card
 * is raised for the owner's own voice note and the plugin's daily caps still
 * count it. No plugin, or nothing set up on Settings → Speech, is one
 * sentence saying where to fix it.
 */
import { localDateString, OWNER_AGENT_ID, type CoreToolContext, type Queryable, type ToolRegistry } from '@buddi/core';

export type VoiceSetting = 'spoken' | 'always' | 'off';
export const VOICE_SETTINGS: readonly VoiceSetting[] = ['spoken', 'always', 'off'];
export const DEFAULT_VOICE: VoiceSetting = 'spoken';

/** Telegram's caption ceiling: past it the text follows as its own message. */
export const MAX_VOICE_CAPTION_CHARS = 1024;
/** An answer longer than this is not read aloud: text only, and nothing said about it. */
export const MAX_SPOKEN_CHARS = 4000;

/* ------------------------------------------------------------------ *
 * The speech plugin, as the surface sees it
 * ------------------------------------------------------------------ */

/** Why a speech call did not give what was asked. */
export type SpeechFailure = 'missing' | 'unconfigured' | 'not-english' | 'failed';

export type SpeechOutcome<T> = ({ ok: true } & T) | { ok: false; reason: SpeechFailure; message: string };

export interface SpeechHooks {
  /** Is there a speaker at all? Decides whether a turn is told it will be read aloud. */
  canSpeak(): boolean;
  transcribe(artifactId: string): Promise<SpeechOutcome<{ text: string; language?: string }>>;
  /** Say `text`; the voice is kept in Files and its id returned. */
  say(text: string): Promise<SpeechOutcome<{ artifactId: string }>>;
}

export interface SpeechHooksDeps {
  registry: Pick<ToolRegistry, 'invoke' | 'list'>;
  ctx: CoreToolContext;
  now: () => Date;
}

export const TRANSCRIBE_TOOL = 'speech.transcribe';
export const SAY_TOOL = 'speech.say';

/** A refusal's words, sorted: nothing set up, a language it cannot speak, or anything else. */
export function classifySpeechRefusal(message: string): SpeechFailure {
  if (/not-english/.test(message)) return 'not-english';
  if (/not set up|is not installed|no account is chosen|chosen in Settings → Speech no longer exists|is disabled in Settings|is not connected/.test(message)) {
    return 'unconfigured';
  }
  return 'failed';
}

/** The two tools through the registry, as the owner. */
export function createSpeechHooks(deps: SpeechHooksDeps): SpeechHooks {
  const has = (name: string): boolean => deps.registry.list().some((t) => t.name === name);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    if (!has(name)) return { ok: false as const, reason: 'missing' as const, message: `${name} is not installed` };
    const { conversationId: _none, ...ctx } = deps.ctx;
    const result = await deps.registry.invoke(name, args, { ...ctx, agentId: OWNER_AGENT_ID, now: deps.now } as CoreToolContext);
    if (result.ok) return { ok: true as const, output: result.output as Record<string, unknown> };
    if (result.reason === 'unknown-tool') return { ok: false as const, reason: 'missing' as const, message: result.message };
    return { ok: false as const, reason: classifySpeechRefusal(result.message), message: result.message };
  };
  return {
    canSpeak: () => has(SAY_TOOL),
    async transcribe(artifactId) {
      const result = await invoke(TRANSCRIBE_TOOL, { artifactId });
      if (!result.ok) return result;
      const text = typeof result.output.text === 'string' ? result.output.text.trim() : '';
      const language = typeof result.output.language === 'string' ? result.output.language : undefined;
      return { ok: true, text, ...(language ? { language } : {}) };
    },
    async say(text) {
      const result = await invoke(SAY_TOOL, { text });
      if (!result.ok) return result;
      const id = result.output.id;
      if (typeof id !== 'string') return { ok: false, reason: 'failed', message: 'speech.say returned no file' };
      return { ok: true, artifactId: id };
    },
  };
}

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

/**
 * A detected language, by its English name: Whisper answers a code ("fr"),
 * OpenAI a name ("french"). Unknown or empty: undefined, and nothing is said.
 */
export function languageName(detected: string | undefined): string | undefined {
  const raw = detected?.trim();
  if (!raw || raw.length > 40) return undefined;
  if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(raw)) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(raw.replace('_', '-'));
      return name && name.toLowerCase() !== raw.toLowerCase() ? name : undefined;
    } catch {
      return undefined;
    }
  }
  if (!/^\p{L}[\p{L} ]*$/u.test(raw)) return undefined;
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/** The transcript, shown back so the owner sees what was heard. */
export function heardText(transcript: string): string {
  return `🎤 ${transcript}`;
}

/** The turn's text: the transcript, then a caption the owner typed under the note. */
export function voiceTurnText(transcript: string, caption: string | undefined): string {
  return caption ? `${transcript}\n\n${caption}` : transcript;
}

export const INSTALL_SPEECH_TEXT = 'To have voice notes heard, install the speech plugin from Settings → Plugins.';
export const SET_UP_LISTENING_TEXT = 'To have voice notes heard, set up listening in Settings → Speech.';
export const NO_WORDS_TEXT = 'I saved the voice note, but heard no words in it.';

/** Transcription refused or failed: one sentence, and the file is kept either way. */
export function notHeardText(message: string): string {
  const why = message.replace(/^refused: /, '').replace(/\.$/, '');
  return `I saved the voice note, but could not transcribe it: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`;
}

/** Why this answer came as text, said at most once a day in a chat. */
export function textInsteadText(reason: SpeechFailure): string {
  switch (reason) {
    case 'not-english':
      return 'I answered in text: the voice on this computer speaks English only.';
    case 'missing':
      return 'I answered in text: voice replies need the speech plugin, from Settings → Plugins.';
    case 'unconfigured':
      return 'I answered in text: voice replies need speaking set up in Settings → Speech.';
    default:
      return 'I answered in text: the voice could not be made this time.';
  }
}

const SETTING_WORDS: Record<VoiceSetting, string> = {
  spoken: 'spoken: a voice note back when you send one',
  always: 'always: every answer is also a voice note',
  off: 'off: answers are text only',
};

/** `/voice` alone: the current value, and the three words. */
export function voiceStatusText(current: VoiceSetting): string {
  return [
    `Voice replies: ${SETTING_WORDS[current]}.`,
    'Send /voice spoken, /voice always or /voice off to change it.',
  ].join('\n');
}

export function voiceSetText(setting: VoiceSetting): string {
  return `Voice replies: ${SETTING_WORDS[setting]}.`;
}

export const VOICE_USAGE_TEXT = 'Send /voice spoken, /voice always or /voice off.';

/** `/voice <word>`: the setting, or undefined when the word is not one of the three. */
export function parseVoiceArg(arg: string): VoiceSetting | undefined {
  const word = arg.trim().toLowerCase();
  return (VOICE_SETTINGS as readonly string[]).includes(word) ? (word as VoiceSetting) : undefined;
}

/** Will this turn's answer be spoken? When the owner spoke (unless off), or always. */
export function answerSpoken(setting: VoiceSetting, ownerSpoke: boolean): boolean {
  return setting === 'always' || (setting === 'spoken' && ownerSpoke);
}

/* ------------------------------------------------------------------ *
 * The chat's setting (core.surface_chat_voice, migration 048)
 * ------------------------------------------------------------------ */

export async function getChatVoice(pool: Queryable, surface: string, chatId: string): Promise<VoiceSetting> {
  const { rows } = await pool.query(
    `select voice from core.surface_chat_voice where surface = $1 and external_chat_id = $2`,
    [surface, chatId],
  );
  const value = rows[0]?.voice;
  return (VOICE_SETTINGS as readonly string[]).includes(value) ? (value as VoiceSetting) : DEFAULT_VOICE;
}

export async function setChatVoice(pool: Queryable, surface: string, chatId: string, voice: VoiceSetting): Promise<void> {
  await pool.query(
    `insert into core.surface_chat_voice (surface, external_chat_id, voice, updated_at)
     values ($1, $2, $3, now())
     on conflict (surface, external_chat_id) do update set voice = excluded.voice, updated_at = now()`,
    [surface, chatId, voice],
  );
}

/**
 * Claim today's "why this came as text" line for a chat: true once per day
 * in the owner's zone, false after that.
 */
export async function claimTextInsteadNote(pool: Queryable, surface: string, chatId: string, now: Date, timezone: string): Promise<boolean> {
  const day = localDateString(now, timezone);
  const { rows } = await pool.query(
    `insert into core.surface_chat_voice (surface, external_chat_id, fallback_noted_on)
     values ($1, $2, $3::date)
     on conflict (surface, external_chat_id) do update set fallback_noted_on = excluded.fallback_noted_on
       where core.surface_chat_voice.fallback_noted_on is distinct from excluded.fallback_noted_on
     returning 1 as claimed`,
    [surface, chatId, day],
  );
  return rows.length > 0;
}
