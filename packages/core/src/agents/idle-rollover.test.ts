import { describe, expect, it } from 'vitest';
import { patchAgentSource, enginePatch, ENGINE_KEYS } from './edit.js';
import { parseAgentFile } from './frontmatter.js';
import { DEFAULT_IDLE_ROLLOVER, idleRolloverMs, isIdleRollover } from './idle-rollover.js';

const FILE = `---
id: demo
handle: demo
name: Demo
description: A demo agent.
tools: []
---

The persona.
`;

describe('the idle rollover setting', () => {
  it('is three hours when the file says nothing', () => {
    expect(parseAgentFile(FILE, { dirName: 'demo' }).frontmatter.idleRollover).toBeUndefined();
    expect(DEFAULT_IDLE_ROLLOVER).toBe('3h');
    expect(idleRolloverMs(undefined)).toBe(3 * 3_600_000);
  });

  it('reads each value the Brain tab offers, and never is no idle limit at all', () => {
    expect(idleRolloverMs('1d')).toBe(24 * 3_600_000);
    expect(idleRolloverMs('1w')).toBe(7 * 24 * 3_600_000);
    expect(idleRolloverMs('never')).toBe(Number.POSITIVE_INFINITY);
    for (const value of ['3h', '1d', '1w', 'never']) {
      const parsed = parseAgentFile(FILE.replace('tools: []', `tools: []\nidleRollover: ${value}`), { dirName: 'demo' });
      expect(parsed.frontmatter.idleRollover).toBe(value);
    }
  });

  it('refuses anything else at load', () => {
    expect(() => parseAgentFile(FILE.replace('tools: []', 'tools: []\nidleRollover: 2d'), { dirName: 'demo' })).toThrow();
    expect(isIdleRollover('2d')).toBe(false);
  });

  it('is an engine key: set it, and null takes it back out', () => {
    expect(ENGINE_KEYS).toContain('idleRollover');
    const set = patchAgentSource(FILE, enginePatch({ idleRollover: '1w' }));
    expect(set.text).toContain('idleRollover: 1w');
    const cleared = patchAgentSource(set.text, enginePatch({ idleRollover: null }));
    expect(cleared.text).not.toContain('idleRollover');
  });
});

describe('where the agent may look', () => {
  it('is an engine key too: browser set from the agent page, null back to the runtime choosing', () => {
    expect(ENGINE_KEYS).toContain('browser');
    const set = patchAgentSource(FILE, enginePatch({ browser: 'chrome' }));
    expect(set.text).toContain('browser: chrome');
    expect(parseAgentFile(set.text, { dirName: 'demo' }).frontmatter.browser).toBe('chrome');
    expect(patchAgentSource(set.text, enginePatch({ browser: null })).text).not.toContain('browser:');
  });
});
