/**
 * The search path, as the catalog sees it: two directories, later wins.
 *
 * Kept apart from `catalog.test.ts` so the single-directory contract and the
 * override rules can be read independently of each other.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../registry.js';
import type { PluginManifest } from '../tools.js';
import { AgentCatalogError, loadAgentCatalog } from './catalog.js';

function registryOf(): ToolRegistry {
  const manifest: PluginManifest = {
    name: 'memory',
    version: '0.0.0',
    schema: 'memory',
    migrationsDir: '/dev/null',
    tools: [
      {
        name: 'memory.note',
        description: 'note',
        tier: 'auto' as const,
        input: z.object({}),
        execute: async () => ({}),
      },
    ],
  };
  const registry = new ToolRegistry();
  registry.register(manifest);
  return registry;
}

interface AgentSpec {
  handle?: string;
  name?: string;
  isDefault?: boolean;
  body?: string;
}

function agentFile(id: string, spec: AgentSpec = {}): string {
  const lines = [
    `id: ${id}`,
    `handle: ${spec.handle ?? id}`,
    `name: ${spec.name ?? id}`,
    `description: the ${spec.name ?? id} agent`,
    'tools: [memory.note]',
    ...(spec.isDefault ? ['default: true'] : []),
  ];
  return `---\n${lines.join('\n')}\n---\n\n${spec.body ?? `You are ${id}.`}\n`;
}

function skillFile(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`;
}

/** Lay out `<root>/<label>/{agents,skills}` and return the agents directory. */
function dirOf(
  root: string,
  label: string,
  agents: Record<string, string>,
  skills: Record<string, string> = {},
): string {
  const dir = path.join(root, label, 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [id, content] of Object.entries(agents)) {
    mkdirSync(path.join(dir, id), { recursive: true });
    writeFileSync(path.join(dir, id, 'agent.md'), content);
  }
  if (Object.keys(skills).length > 0) {
    const skillsDir = path.join(root, label, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    for (const [name, content] of Object.entries(skills)) {
      writeFileSync(path.join(skillsDir, `${name}.md`), content);
    }
  }
  return dir;
}

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'buddi-search-'));
}

const load = (dirs: Array<string | { dir: string; source?: 'example' | 'private' }>) =>
  loadAgentCatalog({ dirs, registry: registryOf(), env: {} });

describe('loadAgentCatalog over a search path', () => {
  it('loads both directories and records where each agent came from', () => {
    const root = tempRoot();
    const examples = dirOf(root, 'examples', { assistant: agentFile('assistant', { isDefault: true }) });
    const owned = dirOf(root, 'private', { ledger: agentFile('ledger') });

    const catalog = load([
      { dir: examples, source: 'example' },
      { dir: owned, source: 'private' },
    ]);

    expect(catalog.list().map((a) => [a.id, a.source])).toEqual([
      ['assistant', 'example'],
      ['ledger', 'private'],
    ]);
    expect(catalog.defaultAgent().id).toBe('assistant');
  });

  it('lets a private agent replace an example one wholesale', () => {
    const root = tempRoot();
    const examples = dirOf(root, 'examples', {
      assistant: agentFile('assistant', { isDefault: true, name: 'Example', body: 'Shipped text.' }),
    });
    const owned = dirOf(root, 'private', {
      assistant: agentFile('assistant', { isDefault: true, name: 'Mine', body: 'My own text.' }),
    });

    const catalog = load([
      { dir: examples, source: 'example' },
      { dir: owned, source: 'private' },
    ]);

    expect(catalog.list()).toHaveLength(1);
    const agent = catalog.resolve('assistant');
    expect(agent.name).toBe('Mine');
    expect(agent.source).toBe('private');
    expect(agent.file.startsWith(owned)).toBe(true);
    // Wholesale, not a merge: nothing of the example survives.
    expect(agent.systemPromptTemplate).toContain('My own text.');
    expect(agent.systemPromptTemplate).not.toContain('Shipped text.');
  });

  it('lets an override change the handle without colliding with what it replaced', () => {
    const root = tempRoot();
    const examples = dirOf(root, 'examples', {
      assistant: agentFile('assistant', { handle: 'assistant', isDefault: true }),
    });
    const owned = dirOf(root, 'private', {
      assistant: agentFile('assistant', { handle: 'buddi', isDefault: true }),
    });

    const catalog = load([
      { dir: examples, source: 'example' },
      { dir: owned, source: 'private' },
    ]);
    expect(catalog.byHandle('buddi')?.id).toBe('assistant');
    expect(catalog.byHandle('assistant')).toBeUndefined();
  });

  it('lets a private skill of the same name replace an example one', () => {
    const root = tempRoot();
    const examples = dirOf(
      root,
      'examples',
      { assistant: agentFile('assistant', { isDefault: true }) },
      { 'house-style': skillFile('house-style', 'Shipped procedure.') },
    );
    const owned = dirOf(
      root,
      'private',
      { ledger: agentFile('ledger') },
      { 'house-style': skillFile('house-style', 'My procedure.') },
    );

    const catalog = load([
      { dir: examples, source: 'example' },
      { dir: owned, source: 'private' },
    ]);
    const agent = catalog.resolve('assistant');
    expect(agent.skills.map((s) => s.name)).toEqual(['house-style']);
    expect(agent.systemPromptTemplate).toContain('My procedure.');
    expect(agent.systemPromptTemplate).not.toContain('Shipped procedure.');
  });

  it('skips a directory that is not on disk', () => {
    const root = tempRoot();
    const owned = dirOf(root, 'private', { ledger: agentFile('ledger', { isDefault: true }) });
    const catalog = load([{ dir: path.join(root, 'nope'), source: 'example' }, { dir: owned }]);
    expect(catalog.list().map((a) => a.id)).toEqual(['ledger']);
  });

  it('fails when no directory on the path exists at all', () => {
    const root = tempRoot();
    expect(() => load([path.join(root, 'a'), path.join(root, 'b')])).toThrow(AgentCatalogError);
  });

  it('still refuses a second file in one directory claiming an id already taken', () => {
    const root = tempRoot();
    const dir = path.join(root, 'private', 'agents');
    mkdirSync(path.join(dir, 'ledger'), { recursive: true });
    mkdirSync(path.join(dir, 'ledger-2'), { recursive: true });
    writeFileSync(path.join(dir, 'ledger', 'agent.md'), agentFile('ledger'));
    // Within one directory the folder *is* the id, so a second claim on it is
    // caught as a mismatch. Overriding is what the next directory is for.
    writeFileSync(
      path.join(dir, 'ledger-2', 'agent.md'),
      agentFile('ledger', { handle: 'ledger-two' }),
    );
    expect(() => load([dir])).toThrow(/id "ledger" does not match its directory/);
  });

  it('rejects two agents in one directory answering to one handle', () => {
    const root = tempRoot();
    const dir = dirOf(root, 'private', {
      ledger: agentFile('ledger', { handle: 'money' }),
      budget: agentFile('budget', { handle: 'money' }),
    });
    expect(() => load([dir])).toThrow(/duplicate agent handle/);
  });

  it('reports `private` for the single-directory form', () => {
    const root = tempRoot();
    const dir = dirOf(root, 'private', { ledger: agentFile('ledger', { isDefault: true }) });
    const catalog = loadAgentCatalog({ dir, registry: registryOf(), env: {} });
    expect(catalog.resolve('ledger').source).toBe('private');
  });
});
