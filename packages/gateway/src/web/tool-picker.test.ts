/**
 * `GET /api/agents/:id/tools` — every installed tool, for the Setup tab's
 * picker. Invented plugins (`orchard`, `shed`, and a `memory` stand-in whose
 * only property is its name) so no real plugin needs installing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { ToolRegistry, type AgentCatalog, type PluginManifest, type CoreToolContext } from '@buddi/core';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGatewayCatalog } from '../agents/catalog.js';
import { withCoreTools } from '../agents/core-tools.js';
import { readToolPicker, type ToolPickerView } from './tool-picker.js';
import { createWebApp } from './server.js';

const env = { ANTHROPIC_API_KEY: 'sk-ant-fixture' } as NodeJS.ProcessEnv;

const tool = (name: string, description: string, tier: 'auto' | 'gated' = 'auto') => ({
  name,
  description,
  tier,
  input: z.object({}).strict(),
  execute: async () => ({ ok: true }),
});

function plugin(name: string, tools: ReturnType<typeof tool>[], extra: Partial<PluginManifest> = {}): PluginManifest {
  return { name, version: '0.2.0', schema: name, migrationsDir: '', tools, ...extra };
}

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(plugin('memory', [tool('memory.note', 'Write a note.'), tool('memory.recall', 'Find a note.')]));
  r.register(
    plugin('orchard', [tool('orchard.rows', 'List the rows.'), tool('orchard.dispatch', 'Send a crate.', 'gated')], {
      agents: [
        {
          id: 'grower',
          handle: 'grower',
          name: 'Grower',
          description: 'Grows things.',
          persona: 'You grow things.',
          // Since the owner accepted, the proposal has come to name a shed tool too.
          tools: ['orchard.*', 'shed.inventory'],
        },
      ],
    }),
  );
  r.register(plugin('shed', [tool('shed.inventory', 'What is on the shelves.')]));
  r.register(
    plugin('platform', [
      tool('platform.list_agents', 'Every agent.'),
      tool('platform.create_agent', 'Create an agent.', 'gated'),
    ]),
  );
  return r;
}

function agentFile(id: string, tools: string[]): string {
  return ['---', `id: ${id}`, `handle: ${id}`, `name: ${id}`, `description: ${id} minds things.`, 'provider: anthropic',
    'model: claude-sonnet-5', `tools: [${tools.map((t) => `'${t}'`).join(', ')}]`, '---', '', `You are ${id}.`, ''].join('\n');
}

describe('the tool picker read', () => {
  let agentsDir: string;
  let catalog: AgentCatalog;
  let reg: ToolRegistry;

  beforeEach(() => {
    agentsDir = path.join(mkdtempSync(path.join(tmpdir(), 'buddi-picker-')), 'agents');
    reg = registry();
    const write = (id: string, tools: string[]): void => {
      mkdirSync(path.join(agentsDir, id), { recursive: true });
      writeFileSync(path.join(agentsDir, id, 'agent.md'), agentFile(id, tools));
    };
    write('keeper', ['orchard.*', 'memory.note']);
    write('grower', ['orchard.*']);
    writeFileSync(
      path.join(agentsDir, 'grower', 'plugin.json'),
      JSON.stringify({ plugin: 'orchard', version: '0.1.0', agent: 'grower', acceptedAt: '2026-09-01T00:00:00Z', proposal: 'x', file: 'y' }),
    );
    catalog = loadGatewayCatalog({ dir: agentsDir, env, registry: reg });
  });

  const read = (id: string): ToolPickerView => readToolPicker({ catalog, registry: reg }, id) as ToolPickerView;

  it('lists every installed tool by plugin, with its own description, and the grant expanded', () => {
    const view = read('keeper');
    expect(view.groups.map((g) => g.plugin)).toEqual(['memory', 'orchard', 'shed', 'platform']);
    expect(view.groups[1]!.tools.find((t) => t.name === 'orchard.dispatch')).toMatchObject({ description: 'Send a crate.', gated: true });
    expect(view.granted.sort()).toEqual(['memory.note', 'orchard.dispatch', 'orchard.rows']);
  });

  it('offers a glob per plugin, except where it would reach a write tool', () => {
    const view = read('keeper');
    expect(view.groups.find((g) => g.plugin === 'orchard')?.glob).toBe('orchard.*');
    expect(view.groups.find((g) => g.plugin === 'platform')?.glob).toBeUndefined();
  });

  it('marks the agent-writing tools as never grantable here, and the read ones as grantable', () => {
    const platform = read('keeper').groups.find((g) => g.plugin === 'platform')!;
    expect(platform.tools.find((t) => t.name === 'platform.create_agent')?.grantable).toBe(false);
    expect(platform.tools.find((t) => t.name === 'platform.list_agents')?.grantable).toBe(true);
  });

  it('tags the memory plugin\'s tools as core', () => {
    const view = read('keeper');
    expect(view.groups[0]!.tools.every((t) => t.core)).toBe(true);
    expect(view.groups[1]!.tools.some((t) => t.core)).toBe(false);
  });

  it('suggests what an accepted proposal names now and the file lacks, and nothing for an agent of the owner\'s', () => {
    expect(read('grower').suggested).toEqual({
      plugin: 'orchard',
      label: 'Suggested by the orchard plugin since you accepted',
      tools: [{ name: 'shed.inventory', description: 'What is on the shelves.' }],
    });
    expect(read('keeper').suggested).toBeUndefined();
  });

  it('answers over the wire, and 404s an unknown agent', async () => {
    const server = createWebApp({
      pool: {} as Pool,
      registry: reg,
      catalog,
      ctx: { ownerId: 'owner' } as unknown as CoreToolContext,
      timezone: 'Europe/Paris',
      now: () => new Date('2026-09-15T09:00:00Z'),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: 'a-test-dashboard-token-long-enough',
      env,
      log: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/agents/grower/tools`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ToolPickerView).suggested?.tools.map((t) => t.name)).toEqual(['shed.inventory']);
      expect((await fetch(`${base}/api/agents/nobody/tools`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  });
});

describe('the core default for a new agent', () => {
  it('appends the memory tools, unless opted out or already reached by the glob', () => {
    const reg = registry();
    expect(withCoreTools(['orchard.rows'], reg, false)).toEqual(['orchard.rows', 'memory.note', 'memory.recall']);
    expect(withCoreTools(['orchard.rows', 'memory.note'], reg, false)).toEqual(['orchard.rows', 'memory.note', 'memory.recall']);
    expect(withCoreTools(['memory.*'], reg, false)).toEqual(['memory.*']);
    expect(withCoreTools(['orchard.rows'], reg, true)).toEqual(['orchard.rows']);
    expect(withCoreTools(['orchard.rows'], new ToolRegistry(), false)).toEqual(['orchard.rows']);
  });
});
