import { describe, expect, it } from 'vitest';
import { PROVIDER_KINDS } from '@buddi/core';
import type { ContentBlock } from './anthropic.js';
import {
  degradeContent,
  degradeMessages,
  DEFAULT_CAPABILITIES,
  providerCapabilities,
} from './capabilities.js';

const pdf: ContentBlock = {
  type: 'document',
  mime: 'application/pdf',
  data: 'JVBER',
  name: 'statement.pdf',
};
const png: ContentBlock = { type: 'image', mime: 'image/png', data: 'AAAA' };

describe('the capability matrix', () => {
  it('has a complete row for every provider this build ships', () => {
    for (const kind of PROVIDER_KINDS) {
      const caps = providerCapabilities(kind);
      expect(caps.kind).toBe(kind);
      for (const field of [
        'streamingToolArgs',
        'multimodalImage',
        'document',
        'parallelToolCalls',
        'cancellation',
        'usageReporting',
      ] as const) {
        expect(typeof caps[field]).toBe('boolean');
      }
      expect(caps.toolResultOrdering).toMatch(/^(blocks-in-user-turn|tool-messages)$/);
    }
  });

  it('records the two wires as genuinely different, not merely both "supported"', () => {
    const anthropic = providerCapabilities('anthropic');
    const openai = providerCapabilities('openai');
    expect(anthropic.document).toBe(true);
    expect(openai.document).toBe(false);
    expect(anthropic.toolResultOrdering).toBe('blocks-in-user-turn');
    expect(openai.toolResultOrdering).toBe('tool-messages');
    expect(openai.multimodalImage).toBe(true);
  });

  it('defaults an undeclared provider to the native wire, never to "everything"', () => {
    expect(DEFAULT_CAPABILITIES).toEqual(providerCapabilities('anthropic'));
  });

  it('throws on a kind it has no row for — a defect, not a configuration problem', () => {
    expect(() => providerCapabilities('gemini' as never)).toThrow(/unknown provider kind/);
  });
});

describe('degrading what a provider cannot carry', () => {
  it('replaces a PDF with a placeholder that says why and what to do', () => {
    const [block] = degradeContent([pdf], providerCapabilities('openai'));
    expect(block?.type).toBe('text');
    const text = (block as { text: string }).text;
    expect(text).toContain('statement.pdf');
    expect(text).toContain('openai');
    expect(text).toContain('paste the');
  });

  it('leaves images alone for a provider that takes them', () => {
    expect(degradeContent([png, pdf], providerCapabilities('openai'))[0]).toBe(png);
  });

  it('changes nothing for a provider that carries everything', () => {
    const content = [png, pdf];
    expect(degradeContent(content, providerCapabilities('anthropic'))).toEqual(content);
  });

  it('returns the same message objects when nothing needs degrading', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
    expect(degradeMessages(messages, providerCapabilities('openai'))[0]).toBe(messages[0]);
  });

  it('degrades a whole history, user turns and replayed attachments alike', () => {
    const degraded = degradeMessages(
      [
        { role: 'user', content: [pdf] },
        { role: 'assistant', content: [{ type: 'text', text: 'read it' }] },
      ],
      providerCapabilities('openai'),
    );
    expect(degraded[0]?.content[0]?.type).toBe('text');
    expect(degraded[1]?.content[0]).toEqual({ type: 'text', text: 'read it' });
  });
});
