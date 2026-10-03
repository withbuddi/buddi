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
