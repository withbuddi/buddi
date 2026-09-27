/** The speech plugin reached by name, as the owner, and the words of voice on Telegram. */
import { describe, expect, it, vi } from 'vitest';
import type { CoreToolContext } from '@buddi/core';
import { answerSpoken, classifySpeechRefusal, createSpeechHooks, languageName, parseVoiceArg, textInsteadText } from './voice.js';

const ctx = { ownerId: 'owner', timezone: 'UTC', conversationId: 'c-1', agentId: 'buddy' } as unknown as CoreToolContext;

function registry(tools: string[], invoke: (name: string, args: unknown, caller: CoreToolContext) => unknown) {
  return {
    list: () => tools.map((name) => ({ name }) as never),
    invoke: vi.fn(async (name: string, args: unknown, caller: CoreToolContext) => invoke(name, args, caller) as never),
  };
}

describe('the speech hooks', () => {
  it('call the tools as the owner, with no conversation, and read their answers', async () => {
    const reg = registry(['speech.transcribe', 'speech.say'], (name) =>
      name === 'speech.transcribe' ? { ok: true, output: { text: ' hello ', language: 'en' } } : { ok: true, output: { id: 'art-9' } });
    const hooks = createSpeechHooks({ registry: reg, ctx, now: () => new Date(0) });
    expect(hooks.canSpeak()).toBe(true);
    expect(await hooks.transcribe('art-1')).toEqual({ ok: true, text: 'hello', language: 'en' });
    expect(await hooks.say('Hi.')).toEqual({ ok: true, artifactId: 'art-9' });
    const caller = reg.invoke.mock.calls[0]![2];
    expect(caller.agentId).toBe('owner');
    expect(caller.conversationId).toBeUndefined();
    expect(reg.invoke.mock.calls.map((c) => [c[0], c[1]])).toEqual([['speech.transcribe', { artifactId: 'art-1' }], ['speech.say', { text: 'Hi.' }]]);
  });

  it('say the plugin is missing without calling anything, and sort refusals', async () => {
    const reg = registry([], () => { throw new Error('not called'); });
    const hooks = createSpeechHooks({ registry: reg, ctx, now: () => new Date(0) });
    expect(hooks.canSpeak()).toBe(false);
    expect(await hooks.transcribe('art-1')).toMatchObject({ ok: false, reason: 'missing' });
    expect(reg.invoke).not.toHaveBeenCalled();

    const refusing = registry(['speech.say'], () => ({ ok: false, reason: 'tool-error', message: 'refused: not-english: Kokoro on this computer speaks English only, and this text is not in English.' }));
    expect(await createSpeechHooks({ registry: refusing, ctx, now: () => new Date(0) }).say('Bonjour')).toMatchObject({ ok: false, reason: 'not-english' });
    expect(classifySpeechRefusal('refused: speaking is not set up. The owner chooses a service in Settings → Speech.')).toBe('unconfigured');
    expect(classifySpeechRefusal('refused: Whisper on this computer is not installed. The owner installs it on Settings → Speech, or with buddi speech install whisper.')).toBe('unconfigured');
    expect(classifySpeechRefusal('refused: 200 replies have been spoken today, and the daily limit is 200.')).toBe('failed');
  });
});

describe('the words', () => {
  it('names a detected language in English, from a code or a name', () => {
    expect(languageName('fr')).toBe('French');
    expect(languageName('pt-BR')).toBe('Brazilian Portuguese');
    expect(languageName('french')).toBe('French');
    expect(languageName('en')).toBe('English');
    expect(languageName('')).toBeUndefined();
    expect(languageName(undefined)).toBeUndefined();
    expect(languageName('zz')).toBeUndefined();
    expect(languageName('<script>')).toBeUndefined();
  });

  it('reads /voice, decides when an answer is spoken, and says why it was not', () => {
    expect(parseVoiceArg(' Always ')).toBe('always');
    expect(parseVoiceArg('loud')).toBeUndefined();
    expect(answerSpoken('spoken', true)).toBe(true);
    expect(answerSpoken('spoken', false)).toBe(false);
    expect(answerSpoken('always', false)).toBe(true);
    expect(answerSpoken('off', true)).toBe(false);
    expect(textInsteadText('unconfigured')).toBe('I answered in text: voice replies need speaking set up in Settings → Speech.');
  });
});
