import { describe, expect, it, vi } from 'vitest';
import { askInto, touchBrowser } from './browser-cards.js';
import type { AskSink } from './pending-question.js';

describe('the browser\'s owner moments on a surface', () => {
  it('a tool\'s ctx.ask becomes the run\'s one question card, labels kept short, first card wins', () => {
    const sink: AskSink = {};
    const ask = askInto(sink);
    ask({ question: 'amazon.com needs your sign-in.', options: [{ label: 'Take over', hint: 'Sign in yourself', recommended: true }, { label: 'Save a login for next time' }], allowOther: false });
    ask({ question: 'A second card', options: [], allowOther: true });
    expect(sink.asked).toEqual({
      question: 'amazon.com needs your sign-in.',
      options: [{ label: 'Take over', hint: 'Sign in yourself', recommended: true }, { label: 'Save a login for next time', hint: null, recommended: false }],
      allowOther: false,
    });
  });
  it('touches the browser when the owner speaks, and a failing browser never costs the turn', async () => {
    const touch = vi.fn(async () => ({ answered: 'takeover' }));
    await expect(touchBrowser({ touch }, { conversationId: 'c1', text: 'Look' })).resolves.toBe('takeover');
    const log = vi.fn();
    await expect(touchBrowser({ touch: async () => { throw new Error('boom'); } }, { conversationId: 'c1' }, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('browser: touch failed: boom');
    await expect(touchBrowser(undefined, { conversationId: 'c1' })).resolves.toBeUndefined();
  });
});

describe('a login wall on a surface that takes the sign-in in place', () => {
  const wall = {
    question: 'Wikimedia needs your sign-in\nSign in on the page and give it back, and I carry on.',
    options: [
      { label: 'Take over', hint: 'Sign in yourself, then give it back', recommended: true },
      { label: 'Use Chrome when it’s open', hint: 'I wait for Chrome, where you are signed in' },
      { label: 'Save a login for next time', hint: 'Keys and secrets, with the site filled in' },
    ],
    allowOther: false,
    signIn: {
      kind: 'sign-in' as const,
      url: 'https://auth.wikimedia.org/enwiki/wiki/Special:UserLogin',
      title: 'Log in - Wikipedia',
      fields: [{ label: 'Username', kind: 'username' as const, ref: 'e3' }, { label: 'Password', kind: 'password' as const, ref: 'e4' }],
    },
  };

  it('becomes the sign-in card: the fields, the site, Chrome folded in as a secondary choice, Take over and Save a login folded into the card', () => {
    const sink: AskSink = {};
    askInto(sink, { agentName: 'Scout' })(wall);
    expect(sink.asked?.question).toBe('No saved sign-in for wikimedia.org');
    expect(sink.asked?.options.map((option) => option.label)).toEqual(['Use Chrome when it’s open', 'Decline']);
    expect(sink.asked?.request).toMatchObject({
      kind: 'secret.request',
      site: 'wikimedia.org',
      origins: ['https://auth.wikimedia.org', 'https://wikimedia.org', 'https://*.wikimedia.org'],
      fields: [{ label: 'Username', kind: 'username', ref: 'e3' }, { label: 'Password', kind: 'password', ref: 'e4' }],
      choices: ['Use Chrome when it’s open'],
      agentName: 'Scout',
    });
  });

  it('offers no Chrome choice when the browser card had none', () => {
    const sink: AskSink = {};
    askInto(sink)({ ...wall, options: wall.options.filter((option) => !option.label.startsWith('Use Chrome')) });
    expect(sink.asked?.options.map((option) => option.label)).toEqual(['Decline']);
    expect(sink.asked?.request?.choices).toBeUndefined();
  });

  it('keeps a code page\'s own card and carries the sign-in card to open in place', () => {
    const sink: AskSink = {};
    askInto(sink)({ ...wall, question: 'Wikimedia asks for a code', signIn: { ...wall.signIn, kind: 'code' } });
    expect(sink.asked?.question).toBe('Wikimedia asks for a code');
    expect(sink.asked?.options.map((option) => option.label)).toContain('Take over');
    expect(sink.asked?.request).toMatchObject({ site: 'wikimedia.org', expand: true });
  });

  it('never stands beside the agent\'s own secret.request for the same page: the first card wins either way', async () => {
    const { createSecretRequestManifest } = await import('./secret-request.js');
    const { ToolRegistry } = await import('@buddi/core');
    const browserFirst: AskSink = {};
    askInto(browserFirst)(wall);
    const registry = new ToolRegistry();
    registry.register(createSecretRequestManifest(browserFirst, { pool: { query: async () => ({ rows: [] }) } as never, browser: { status: () => ({ state: 'running', enabled: true, busy: false, hasScreenshot: false, page: { id: 'p', url: wall.signIn.url, title: 't' } }) } as never }));
    const ctx = { agentId: 'scout', conversationId: '11111111-1111-4111-8111-111111111111', db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    const refused = await registry.invoke('secret.request', { fields: [{ label: 'Password', kind: 'password' }] }, ctx as never);
    expect(refused.ok).toBe(false);
    expect(browserFirst.asked?.request?.choices).toEqual(['Use Chrome when it’s open']);

    const agentFirst: AskSink = {};
    const registry2 = new ToolRegistry();
    registry2.register(createSecretRequestManifest(agentFirst, { pool: { query: async () => ({ rows: [] }) } as never, browser: { status: () => ({ state: 'running', enabled: true, busy: false, hasScreenshot: false, page: { id: 'p', url: wall.signIn.url, title: 't' } }) } as never }));
    expect((await registry2.invoke('secret.request', { fields: [{ label: 'Password', kind: 'password' }] }, ctx as never)).ok).toBe(true);
    const before = agentFirst.asked;
    askInto(agentFirst)(wall);
    expect(agentFirst.asked).toBe(before);
  });
});
