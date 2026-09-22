/**
 * What an owner is told to do about the agents a plugin proposes.
 *
 * Installing creates none of them, and the sentence that said so used to be
 * "ask your agent for one by name". The owner then asked whichever agent they
 * were talking to — which does not hold the tools that make agents and could
 * only say no — and the proposed agent stayed unaccepted. Exactly one agent
 * can accept one, so the sentence names it and the example is the whole thing
 * to type.
 */
import { describe, expect, it } from 'vitest';
import { acceptAgentSteps } from './install.js';

describe('the lines printed after installing a plugin that proposes agents', () => {
  it('names Agent Father and gives the sentence to say, one per agent', () => {
    const lines = acceptAgentSteps('developer', [{ id: 'developer' }, { id: 'reviewer' }]);
    expect(lines[0]).toBe(
      'It proposes agents. Nothing was created — Agent Father is the one agent that can make them:',
    );
    expect(lines).toContain('  Ask Agent Father: "accept the developer agent from the developer plugin"');
    expect(lines).toContain('  Ask Agent Father: "accept the reviewer agent from the developer plugin"');
    expect(lines[lines.length - 1]).toBe('You will be shown the whole tool grant and asked to approve it.');
  });

  it('says nothing at all when a plugin proposes no agent', () => {
    expect(acceptAgentSteps('weather', [])).toEqual([]);
  });
});
