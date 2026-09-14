import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type ToolContext } from '@buddi/core';
import { DELEGATE_TOOL } from '@buddi/runtime';
import { AGENTS_DIR, createToolRegistry } from './catalog.js';
import {
  bindDelegation,
  createDelegationManifest,
  readDelegates,
} from './delegation.js';

function agentsDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-delegates-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return dir;
}

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  ownerId: 'owner',
  now: () => new Date('2026-09-13T00:00:00Z'),
  timezone: 'UTC',
  agentId: 'finance-advisor',
};

describe('readDelegates', () => {
  it('reads the allowlist next to the agent file', () => {
    const dir = agentsDirWith({ 'finance-advisor/delegates.json': '["credit-coach"]' });
    expect(readDelegates('finance-advisor', dir)).toEqual(['credit-coach']);
  });

  it('treats a missing file as no delegation at all', () => {
    const dir = agentsDirWith({});
    expect(readDelegates('credit-coach', dir)).toEqual([]);
  });

  it('throws on a file that is not a JSON array of ids', () => {
    const dir = agentsDirWith({
      'a/delegates.json': '{"to": "credit-coach"}',
      'b/delegates.json': 'not json',
      'c/delegates.json': '["", 3]',
    });
    expect(() => readDelegates('a', dir)).toThrow(/JSON array of agent ids/);
    expect(() => readDelegates('b', dir)).toThrow(/not valid JSON/);
    expect(() => readDelegates('c', dir)).toThrow(/JSON array of agent ids/);
  });

  it('ships finance-advisor -> credit-coach, and nothing for credit-coach', () => {
    expect(readDelegates('finance-advisor', AGENTS_DIR)).toEqual(['credit-coach']);
    expect(readDelegates('credit-coach', AGENTS_DIR)).toEqual([]);
  });
});

describe('the agent plugin', () => {
  it('is registered in this build, so agent files can grant agent.delegate', () => {
    const registry = createToolRegistry();
    expect(registry.has(DELEGATE_TOOL)).toBe(true);
    expect(registry.manifests().map((m) => m.name)).toContain('agent');
  });

  it('refuses to delegate until a catalog and provider are bound', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createDelegationManifest(registry, {
        agentsDir: agentsDirWith({ 'finance-advisor/delegates.json': '["credit-coach"]' }),
      }),
    );
    const out = await registry.invoke(
      DELEGATE_TOOL,
      { agent: 'credit-coach', task: 'what is my utilization?' },
      ctx,
    );
    expect(out).toMatchObject({ ok: false, reason: 'tool-error' });
    expect(out.ok === false && out.message).toContain('no agent catalog bound');
  });

  it('refuses a colleague the allowlist file does not name, even once bound', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createDelegationManifest(registry, {
        agentsDir: agentsDirWith({ 'finance-advisor/delegates.json': '["credit-coach"]' }),
      }),
    );
    bindDelegation(registry, {
      catalog: {
        get: () => undefined,
        list: () => [{ id: 'concierge' }],
      },
      provider: { complete: async () => { throw new Error('never called'); } },
    });
    const out = await registry.invoke(
      DELEGATE_TOOL,
      { agent: 'concierge', task: 'anything' },
      ctx,
    );
    expect(out.ok === false && out.message).toContain('may not delegate to "concierge"');
  });
});
