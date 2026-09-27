/**
 * The dashboard's speech routes: the plugin's tools by name, as the owner,
 * through a fake registry; a missing or unset plugin is a 409 with a sentence.
 */
import { describe, expect, it, vi } from 'vitest';
import { OWNER_AGENT_ID } from '@buddi/core';
import { refusalSentence, sayRoute, transcribeRoute, INSTALL_SPEECH_SENTENCE, type SpeechRouteDeps } from './speech.js';

const ARTIFACT = '11111111-2222-4333-8444-555555555555';
const CONVERSATION = '99999999-2222-4333-8444-555555555555';

function fakeDeps(tools: string[], invoke: ReturnType<typeof vi.fn>): SpeechRouteDeps {
  return {
    pool: {} as never,
    registry: { list: () => tools.map((name) => ({ name })) as never, invoke: invoke as never },
    ctx: { agentId: 'someone', conversationId: 'stale' } as never,
    agents: () => [{ handle: 'ledger', name: 'Ledger' }, { handle: undefined, name: 'Nameless' }],
    now: () => new Date('2026-09-27T10:00:00Z'),
  };
}

describe('POST /api/speech/transcribe', () => {
  it('invokes speech.transcribe as the owner and returns the text', async () => {
    const invoke = vi.fn(async () => ({ ok: true, output: { text: ' hello there ', language: 'en' } }));
    const res = await transcribeRoute(fakeDeps(['speech.transcribe'], invoke), { artifactId: ARTIFACT, conversationId: CONVERSATION });
    expect(res).toEqual({ status: 200, body: { text: 'hello there', language: 'en' } });
    const [name, args, ctx] = invoke.mock.calls[0]! as unknown as [string, unknown, { agentId: string; conversationId?: string }];
    expect(name).toBe('speech.transcribe');
    expect(args).toEqual({ artifactId: ARTIFACT });
    expect(ctx.agentId).toBe(OWNER_AGENT_ID);
    expect(ctx.conversationId).toBe(CONVERSATION);
  });

  it('is a 409 with the install sentence when the plugin is missing', async () => {
    const invoke = vi.fn();
    const res = await transcribeRoute(fakeDeps([], invoke), { artifactId: ARTIFACT });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: INSTALL_SPEECH_SENTENCE, reason: 'missing' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is a 409 with the plugin's sentence when listening is not set up", async () => {
    const invoke = vi.fn(async () => ({ ok: false, reason: 'refused', message: 'refused: listening is not set up. Choose a service in Settings → Speech.' }));
    const res = await transcribeRoute(fakeDeps(['speech.transcribe'], invoke), { artifactId: ARTIFACT });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Listening is not set up. Choose a service in Settings → Speech.', reason: 'unconfigured' });
  });

  it('refuses a body without an artifact id', async () => {
    const invoke = vi.fn();
    expect((await transcribeRoute(fakeDeps(['speech.transcribe'], invoke), { artifactId: 'nope' })).status).toBe(400);
  });

  it('says when no words were heard', async () => {
    const invoke = vi.fn(async () => ({ ok: true, output: { text: '  ' } }));
    const res = await transcribeRoute(fakeDeps(['speech.transcribe'], invoke), { artifactId: ARTIFACT });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/speech/say', () => {
  it('invokes speech.say as the owner with the handle map and returns the audio URL', async () => {
    const invoke = vi.fn(async () => ({ ok: true, output: { id: ARTIFACT, mime: 'audio/ogg' } }));
    const res = await sayRoute(fakeDeps(['speech.say'], invoke), { text: 'Ask @ledger.', conversationId: CONVERSATION });
    expect(res).toEqual({ status: 200, body: { artifactId: ARTIFACT, audioUrl: `/api/artifacts/${ARTIFACT}/download`, mime: 'audio/ogg' } });
    const [name, args, ctx] = invoke.mock.calls[0]! as unknown as [string, unknown, { agentId: string }];
    expect(name).toBe('speech.say');
    expect(args).toEqual({ text: 'Ask @ledger.', handles: { ledger: 'Ledger' } });
    expect(ctx.agentId).toBe(OWNER_AGENT_ID);
  });

  it('is a 409 naming not-english when the local voice cannot speak it', async () => {
    const invoke = vi.fn(async () => ({ ok: false, reason: 'refused', message: 'refused (not-english): the voice on this computer speaks English only.' }));
    const res = await sayRoute(fakeDeps(['speech.say'], invoke), { text: 'Bonjour.' });
    expect(res.status).toBe(409);
    expect((res.body as { reason: string }).reason).toBe('not-english');
  });

  it('refuses an empty text', async () => {
    expect((await sayRoute(fakeDeps(['speech.say'], vi.fn()), { text: ' ' })).status).toBe(400);
  });
});

describe('refusalSentence', () => {
  it('drops the prefix and ends with a stop', () => {
    expect(refusalSentence('failed', 'refused: the daily limit is 200')).toBe('The daily limit is 200.');
  });
});
