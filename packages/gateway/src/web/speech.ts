/**
 * Talking to buddi on the dashboard (docs/dashboard.md, Talking to buddi).
 *
 * Two owner routes over the speech plugin's model-facing tools, called by
 * name through the registry as the owner, exactly as Telegram hears and
 * answers a voice note (`../telegram/voice.ts`, `createSpeechHooks`): no
 * approval card for the owner's own voice, and the plugin's daily caps count
 * every use.
 *
 *  - `POST /api/speech/transcribe { artifactId, conversationId? }` → `{ text, language? }`.
 *    The recording was uploaded as a chat attachment first.
 *  - `POST /api/speech/say { text, conversationId? }` → `{ artifactId, audioUrl, mime }`.
 *    Handles are read as the agents' names; the dashboard is not a spoken
 *    surface, so the plugin's ear rewrite does the rest.
 *
 * No plugin, nothing set up, or a text the voice cannot speak is a 409 with
 * one sentence and a `reason` the page can act on.
 */
import type { Pool } from 'pg';
import type { CoreToolContext, ToolRegistry } from '@buddi/core';
import { createSpeechHooks, MAX_SPOKEN_CHARS, type SpeechFailure, type SpeechHooks } from '../telegram/voice.js';

export interface SpeechRouteDeps {
  pool: Pool;
  registry: Pick<ToolRegistry, 'invoke' | 'list'>;
  ctx: Omit<CoreToolContext, 'db'>;
  /** Every agent's handle and name, so a spoken `@ledger` is read as its name. */
  agents: () => Array<{ handle?: string | undefined; name?: string | undefined }>;
  now?: () => Date;
  /** For tests: the hooks themselves. */
  hooks?: SpeechHooks;
}

export interface RouteReply {
  status: number;
  body: unknown;
}

const reply = (status: number, body: unknown): RouteReply => ({ status, body });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_ENGLISH_SENTENCE = 'Replies are not read aloud: the voice on this computer does not speak this language.';
export const INSTALL_SPEECH_SENTENCE = 'Talking to buddi needs the speech plugin, from Settings → Plugins.';

function hooksOf(deps: SpeechRouteDeps): SpeechHooks {
  return deps.hooks ?? createSpeechHooks({
    registry: deps.registry,
    ctx: { ...deps.ctx, db: deps.pool } as CoreToolContext,
    now: deps.now ?? (() => new Date()),
  });
}

/** The plugin's refusal as a sentence the page can show: no "refused:" prefix, a capital, a stop. */
export function refusalSentence(reason: SpeechFailure, message: string): string {
  if (reason === 'missing') return INSTALL_SPEECH_SENTENCE;
  if (reason === 'not-english') return NOT_ENGLISH_SENTENCE;
  const bare = message.replace(/^refused:\s*/i, '').trim();
  if (bare === '') return 'The speech plugin could not do that this time.';
  const capital = bare.charAt(0).toUpperCase() + bare.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

function failure(reason: SpeechFailure, message: string): RouteReply {
  // What the owner must fix is a conflict with the setup; anything else is the service's failure.
  const status = reason === 'failed' ? 502 : 409;
  return reply(status, { error: refusalSentence(reason, message), reason });
}

function conversationOf(body: Record<string, unknown>): string | undefined {
  const id = body.conversationId;
  return typeof id === 'string' && UUID.test(id) ? id : undefined;
}

/** `POST /api/speech/transcribe` — the recording, heard. */
export async function transcribeRoute(deps: SpeechRouteDeps, body: Record<string, unknown>): Promise<RouteReply> {
  const artifactId = body.artifactId;
  if (typeof artifactId !== 'string' || !UUID.test(artifactId)) return reply(400, { error: 'Send `{ artifactId }`, the uploaded recording.' });
  let heard;
  try {
    heard = await hooksOf(deps).transcribe(artifactId, conversationOf(body));
  } catch (err) {
    return failure('failed', err instanceof Error ? err.message : String(err));
  }
  if (!heard.ok) return failure(heard.reason, heard.message);
  if (heard.text === '') return reply(422, { error: 'No words were heard in that recording.', reason: 'empty' });
  return reply(200, { text: heard.text, ...(heard.language ? { language: heard.language } : {}) });
}

/** `POST /api/speech/say` — a reply, spoken; the page plays the file. */
export async function sayRoute(deps: SpeechRouteDeps, body: Record<string, unknown>): Promise<RouteReply> {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '') return reply(400, { error: 'Send `{ text }`, the reply to read aloud.' });
  if (text.length > MAX_SPOKEN_CHARS) return reply(413, { error: 'That reply is too long to read aloud.', reason: 'too-long' });
  const handles: Record<string, string> = {};
  try {
    for (const agent of deps.agents()) if (agent.handle && agent.name) handles[agent.handle] = agent.name;
  } catch {
    // No names: handles are read as bare words.
  }
  let said;
  try {
    said = await hooksOf(deps).say(text, handles, conversationOf(body));
  } catch (err) {
    return failure('failed', err instanceof Error ? err.message : String(err));
  }
  if (!said.ok) return failure(said.reason, said.message);
  return reply(200, {
    artifactId: said.artifactId,
    audioUrl: `/api/artifacts/${encodeURIComponent(said.artifactId)}/download`,
    mime: said.mime ?? 'audio/ogg',
  });
}
