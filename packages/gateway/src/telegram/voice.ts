/**
 * Voice on Telegram (docs/telegram.md, Voice).
 *
 * In: a voice note is transcribed by the speech plugin's `speech.transcribe`
 * and run as if the owner had typed it; nothing is echoed back, the transcript
 * is the owner's message in the conversation. Out: when the owner spoke (or
 * chose `/voice always`), the answer is synthesized with `speech.say` (which
 * rewrites it for the ear first) and sent as a voice note, alone or with the
 * text as its caption (`/voice voice|both`).
 *
 * The two choices live in the chat's row (core.surface_chat_voice) and, when
 * the plugin is there, in its own copy (`speech.telegram_voice`, Settings →
 * Speech → On Telegram): the plugin's copy wins where it has one, and
 * `/voice` writes both.
 *
 * buddi does not know the speech plugin: it calls its tools **by name**
 * through the registry, as the owner (`OWNER_AGENT_ID`), so no approval card
 * is raised for the owner's own voice note and the plugin's daily caps still
 * count it. No plugin, or nothing set up on Settings → Speech, is one
 * sentence saying where to fix it.
 */
import { localDateString, OWNER_AGENT_ID, type CoreToolContext, type Queryable, type ToolRegistry } from '@buddi/core';

/** When an answer is spoken: when the owner spoke, always, or never. */
export type VoiceWhen = 'spoken' | 'always' | 'off';
/** What is sent: the voice note alone, or with the text as its caption. */
export type VoiceForm = 'voice' | 'both';
export const VOICE_WHEN: readonly VoiceWhen[] = ['spoken', 'always', 'off'];
export const VOICE_FORM: readonly VoiceForm[] = ['voice', 'both'];

export interface ChatVoice {
  when: VoiceWhen;
  form: VoiceForm;
}

export const DEFAULT_CHAT_VOICE: ChatVoice = { when: 'spoken', form: 'voice' };

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
  /** Say `text` (handles read as the names given); the voice is kept in Files and its id returned. */
  say(text: string, handles?: Record<string, string>): Promise<SpeechOutcome<{ artifactId: string }>>;
  /** The plugin's copy of the two choices (Settings → Speech); `{}` when it has none. */
  voicePrefs?(): Promise<Partial<ChatVoice>>;
  /** Write the two choices to the plugin's copy too; false when it could not be. */
  saveVoicePrefs?(voice: ChatVoice): Promise<boolean>;
}

export interface SpeechHooksDeps {
  registry: Pick<ToolRegistry, 'invoke' | 'list'>;
  ctx: CoreToolContext;
  now: () => Date;
}

export const TRANSCRIBE_TOOL = 'speech.transcribe';
export const SAY_TOOL = 'speech.say';
/** Owner-only, so never in `registry.list()`: reached by invoking it. */
export const TELEGRAM_VOICE_TOOL = 'speech.telegram_voice';

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
  /** An owner-only tool, invoked straight away; undefined when it is not there or refused. */
  const ownerCall = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    const { conversationId: _none, ...ctx } = deps.ctx;
    const result = await deps.registry.invoke(name, args, { ...ctx, agentId: OWNER_AGENT_ID, now: deps.now } as CoreToolContext);
    return result.ok && result.output && typeof result.output === 'object' ? (result.output as Record<string, unknown>) : undefined;
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
    async say(text, handles) {
      const result = await invoke(SAY_TOOL, { text, ...(handles && Object.keys(handles).length > 0 ? { handles } : {}) });
      if (!result.ok) return result;
      const id = result.output.id;
      if (typeof id !== 'string') return { ok: false, reason: 'failed', message: 'speech.say returned no file' };
      return { ok: true, artifactId: id };
    },
    async voicePrefs() {
      const result = await ownerCall(TELEGRAM_VOICE_TOOL, {});
      if (!result) return {};
      const when = result.when;
      const form = result.form;
      return {
        ...((VOICE_WHEN as readonly unknown[]).includes(when) ? { when: when as VoiceWhen } : {}),
        ...((VOICE_FORM as readonly unknown[]).includes(form) ? { form: form as VoiceForm } : {}),
      };
    },
    async saveVoicePrefs(voice) {
      return (await ownerCall(TELEGRAM_VOICE_TOOL, { when: voice.when, form: voice.form })) !== undefined;
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

const WHEN_WORDS: Record<Exclude<VoiceWhen, 'off'>, string> = {
  spoken: 'when you send a voice note',
  always: 'for every answer',
};

const FORM_WORDS: Record<VoiceForm, string> = {
  voice: 'as the voice note alone',
  both: 'as a voice note with the text',
};

/** "when you send a voice note, as the voice note alone", or "off: answers are text only". */
export function voiceSummary(voice: ChatVoice): string {
  return voice.when === 'off' ? 'off: answers are text only' : `${WHEN_WORDS[voice.when]}, ${FORM_WORDS[voice.form]}`;
}

export const VOICE_USAGE_TEXT = 'Send /voice spoken, always or off for when, and /voice voice, both or text for what.';

/** `/voice` alone: the current choice and the words it takes, on one line. */
export function voiceStatusText(current: ChatVoice): string {
  return `Voice replies: ${voiceSummary(current)}. ${VOICE_USAGE_TEXT}`;
}

export function voiceSetText(voice: ChatVoice): string {
  return `Voice replies: ${voiceSummary(voice)}.`;
}

/**
 * `/voice <word>` over the current choice: spoken, always or off set when;
 * voice or both set what (and turn an `off` chat back to spoken); text is
 * off. Undefined when the word is none of these.
 */
export function applyVoiceArg(current: ChatVoice, arg: string): ChatVoice | undefined {
  const word = arg.trim().toLowerCase();
  if ((VOICE_WHEN as readonly string[]).includes(word)) return { ...current, when: word as VoiceWhen };
  if ((VOICE_FORM as readonly string[]).includes(word)) {
    return { when: current.when === 'off' ? 'spoken' : current.when, form: word as VoiceForm };
  }
  if (word === 'text') return { ...current, when: 'off' };
  return undefined;
}

/** Will this turn's answer be spoken? When the owner spoke (unless off), or always. */
export function answerSpoken(when: VoiceWhen, ownerSpoke: boolean): boolean {
  return when === 'always' || (when === 'spoken' && ownerSpoke);
}

/* ------------------------------------------------------------------ *
 * The chat's setting (core.surface_chat_voice, migrations 048 and 049)
 * ------------------------------------------------------------------ */

export async function getChatVoice(pool: Queryable, surface: string, chatId: string): Promise<ChatVoice> {
  const { rows } = await pool.query(
    `select voice_when, voice_form from core.surface_chat_voice where surface = $1 and external_chat_id = $2`,
    [surface, chatId],
  );
  const when = rows[0]?.voice_when;
  const form = rows[0]?.voice_form;
  return {
    when: (VOICE_WHEN as readonly string[]).includes(when) ? (when as VoiceWhen) : DEFAULT_CHAT_VOICE.when,
    form: (VOICE_FORM as readonly string[]).includes(form) ? (form as VoiceForm) : DEFAULT_CHAT_VOICE.form,
  };
}

export async function setChatVoice(pool: Queryable, surface: string, chatId: string, voice: ChatVoice): Promise<void> {
  await pool.query(
    `insert into core.surface_chat_voice (surface, external_chat_id, voice_when, voice_form, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (surface, external_chat_id) do update
       set voice_when = excluded.voice_when, voice_form = excluded.voice_form, updated_at = now()`,
    [surface, chatId, voice.when, voice.form],
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
