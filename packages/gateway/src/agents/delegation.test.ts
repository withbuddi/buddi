import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentCatalog, ToolRegistry, type CoreToolContext } from '@buddi/core';
import { DELEGATE_TOOL } from '@buddi/runtime';
import { AGENTS_DIR, createToolRegistry, loadGatewayCatalog } from './catalog.js';
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

const ctx: CoreToolContext = {
  db: {} as CoreToolContext['db'],
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

  it('names a colleague once, however often the file does', () => {
    const dir = agentsDirWith({ 'finance-advisor/delegates.json': '["credit-coach", "credit-coach", " credit-coach "]' });
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

  it('reads the installed allowlists as ids of installed agents, whatever they are', () => {
    // Not a copy of this owner's allowlist: `private/` is gitignored, a fresh
    // clone has none of it, and an owner who makes an agent must not break the
    // platform's suite. What holds for any installation, including one with no
    // private agents at all: every allowlist next to an installed agent parses,
    // and every id in one names an agent this catalog knows.
    const catalog = loadGatewayCatalog({ env: {} });
    const known = new Set(catalog.list().map((a) => a.id));
    for (const summary of catalog.list()) {
      const agentsDir = path.dirname(path.dirname(catalog.resolve(summary.id).file));
      for (const target of readDelegates(summary.id, agentsDir)) {
        expect(known, `${summary.id} -> ${target}`).toContain(target);
      }
    }
    // And an agent with no file of its own delegates to nobody.
    expect(readDelegates('no-such-agent', AGENTS_DIR)).toEqual([]);
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
    expect(out.ok === false && out.message).toBe(
      "delegation refused: @finance-advisor may delegate to @credit-coach; @concierge is not on its list. The owner adds it on @finance-advisor's Access page.",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The allowlist, as the model reads it
 * ------------------------------------------------------------------ */

/**
 * `agent.delegate` takes a catalog **id**. An agent shown only its
 * colleagues' handles — which is what the wiring paragraph used to carry —
 * guesses an id, is refused, guesses another, and burns a turn on each. So
 * the allowlist it actually has is named in the prompt, with the ids to pass.
 */
function agentFile(id: string, over: { tools?: string; description?: string } = {}): string {
  return [
    '---',
    `id: ${id}`,
    `handle: ${id}`,
    `name: ${id[0]!.toUpperCase()}${id.slice(1)}`,
    `description: ${over.description ?? `${id} does ${id} things`}`,
    `tools: [${over.tools ?? ''}]`,
    '---',
    '',
    `You are ${id}.`,
    '',
  ].join('\n');
}

describe('the front desk and the maker ask everyone', () => {
  const dir = (extra: Record<string, string> = {}): string =>
    agentsDirWith({
      'desk/agent.md': agentFile('desk', { tools: 'agent.delegate' }).replace('tools:', 'roles: [front-desk]\ntools:'),
      'ledger/agent.md': agentFile('ledger', { description: 'Keeps the books' }),
      'maker/agent.md': agentFile('maker', { tools: 'agent.delegate, platform.create_agent' }).replace('tools:', 'roles: [maker]\ntools:'),
      ...extra,
    });

  it('offers every colleague that does not write the installation, with no list', () => {
    const catalog = loadGatewayCatalog({ env: {}, dir: dir() });
    const prompt = catalog.get('desk')!.systemPromptTemplate;
    expect(prompt).toContain('`ledger` (@ledger)');
    expect(prompt).not.toContain('`maker` (@maker)');
    expect(catalog.get('maker')!.systemPromptTemplate).toContain('`desk` (@desk)');
  });

  it('is narrowed by an explicit list', () => {
    const prompt = loadGatewayCatalog({ env: {}, dir: dir({ 'desk/delegates.json': '[]' }) }).get('desk')!.systemPromptTemplate;
    expect(prompt).toContain('You may not delegate to anyone');
  });
});

describe('the delegate roster in an agent\'s context', () => {
  const dir = (): string =>
    agentsDirWith({
      'asker/agent.md': agentFile('asker', { tools: 'agent.delegate' }),
      'asker/delegates.json': '["ledger"]',
      'ledger/agent.md': agentFile('ledger', { description: 'Keeps the books' }),
      'postman/agent.md': agentFile('postman'),
    });

  it('names every colleague it may ask, by the id the tool takes', () => {
    const prompt = loadGatewayCatalog({ env: {}, dir: dir() }).get('asker')!.systemPromptTemplate;
    expect(prompt).toContain('`ledger` (@ledger) — Ledger: Keeps the books');
    expect(prompt).toMatch(/Colleagues you may ask with agent\.delegate/);
    // Only the allowlist. A colleague it may not ask is on the roster as
    // somebody to name, never as somebody to hand work to.
    expect(prompt).not.toContain('`postman` (@postman)');
    // And what to say about the rest, instead of improvising or probing.
    expect(prompt).toContain('A colleague not listed here is not on your delegate list');
    expect(prompt).toContain('you can add it on my Access page');
    expect(prompt).toContain('Do not call agent.delegate to test.');
  });

  /*
   * With a search path the owner's agents and the shipped examples live in
   * two directories. The allowlist is read from the one the agent's own file
   * is in — reaching for a single default would print nothing here.
   */
  it('reads the allowlist from the directory the agent itself came from', () => {
    const owner = agentsDirWith({
      'asker/agent.md': agentFile('asker', { tools: 'agent.delegate' }),
      'asker/delegates.json': '["ledger"]',
    });
    const examples = agentsDirWith({ 'ledger/agent.md': agentFile('ledger', { description: 'Keeps the books' }) });
    const catalog = loadAgentCatalog({
      dirs: [{ dir: examples, source: 'example' }, { dir: owner, source: 'private' }],
      registry: createToolRegistry({}),
      env: {},
      delegatesFor: (agentId, agentsDir) => readDelegates(agentId, agentsDir),
    });
    expect(catalog.get('asker')!.systemPromptTemplate).toContain('`ledger` (@ledger) — Ledger: Keeps the books');
  });

  it('marks a colleague this installation cannot run', () => {
    const prompt = loadGatewayCatalog({ env: {}, dir: dir() }).get('asker')!.systemPromptTemplate;
    // No credential anywhere in this env: every colleague is offered as one
    // that cannot take a turn right now.
    expect(prompt).toContain('`ledger` (@ledger) — Ledger: Keeps the books (not available now)');
  });

  it('says so plainly when an agent holds the tool and may ask nobody', () => {
    const empty = agentsDirWith({ 'asker/agent.md': agentFile('asker', { tools: 'agent.delegate' }) });
    expect(loadGatewayCatalog({ env: {}, dir: empty }).get('asker')!.systemPromptTemplate)
      .toContain('You may not delegate to anyone');
  });

  it('says nothing at all to an agent that was never granted the tool', () => {
    const prompt = loadGatewayCatalog({ env: {}, dir: dir() }).get('ledger')!.systemPromptTemplate;
    expect(prompt).not.toContain('Colleagues you may ask');
  });
});
