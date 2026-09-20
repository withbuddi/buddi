/**
 * The opening the wizard writes into the owner's first agent.
 *
 * Two things have to hold: the loader must accept it — an opening that fails
 * validation would turn the wizard's last step into a refusal — and it must
 * not promise anything the first agent's grant cannot do.
 */
import { INTRO_MAX, STARTER_MAX, STARTERS_MAX, parseAgentFile } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { FIRST_AGENT_OPENING, defaultThinkingFor } from './opening.js';
import { composeAgentFile } from './platform-files.js';

describe('the first agent’s opening', () => {
  it('fits what an agent file may carry', () => {
    expect(FIRST_AGENT_OPENING.intro.length).toBeLessThanOrEqual(INTRO_MAX);
    expect(FIRST_AGENT_OPENING.starters.length).toBeLessThanOrEqual(STARTERS_MAX);
    for (const starter of FIRST_AGENT_OPENING.starters) {
      expect(starter.length).toBeLessThanOrEqual(STARTER_MAX);
    }
  });

  it('survives being composed into a file and read back', () => {
    const content = composeAgentFile({
      id: 'ada', handle: 'ada', name: 'Ada', description: 'The owner’s assistant',
      tools: ['memory.*'], persona: 'You are Ada.',
      intro: FIRST_AGENT_OPENING.intro,
      starters: [...FIRST_AGENT_OPENING.starters],
    });
    const { frontmatter } = parseAgentFile(content, { dirName: 'ada' });
    expect(frontmatter.intro).toBe(FIRST_AGENT_OPENING.intro);
    expect(frontmatter.starters).toEqual([...FIRST_AGENT_OPENING.starters]);
  });
});

describe('what a first agent thinks by default', () => {
  it('turns thinking off on a local or self-hosted endpoint, and nowhere else', () => {
    // Ollama, on this machine or in its cloud: a small model reasoning out
    // loud before every answer makes the first conversation read as broken.
    expect(defaultThinkingFor('openai-compatible')).toBe('off');
    for (const kind of ['anthropic', 'openai', 'codex', undefined]) {
      expect(defaultThinkingFor(kind)).toBeUndefined();
    }
  });

  it('writes nothing at all when the answer is the model’s own default', () => {
    const content = composeAgentFile({
      id: 'ada', handle: 'ada', name: 'Ada', description: 'The owner’s assistant',
      tools: ['memory.*'], persona: 'You are Ada.',
      ...(defaultThinkingFor('anthropic') === undefined ? {} : { thinking: defaultThinkingFor('anthropic') }),
    });
    expect(content).not.toContain('thinking:');
    expect(parseAgentFile(content, { dirName: 'ada' }).frontmatter.thinking).toBeUndefined();

    const local = composeAgentFile({
      id: 'ada', handle: 'ada', name: 'Ada', description: 'The owner’s assistant',
      tools: ['memory.*'], persona: 'You are Ada.',
      thinking: defaultThinkingFor('openai-compatible'),
    });
    expect(parseAgentFile(local, { dirName: 'ada' }).frontmatter.thinking).toBe('off');
  });
});
