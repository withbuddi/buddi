/**
 * Disabling and enabling a plugin in the running gateway: its tools, pages,
 * glances, sources and sentinels leave the registry at once (and so every read
 * route and loop that reads it), an agent's grant to it is skipped on the next
 * resolve, and enabling brings all of it back without a restart.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  collectSentinels,
  collectSources,
  resolveToolGrants,
  ToolRegistry,
  type InstalledPlugin,
} from '@buddi/core';
import { listPageDescriptors } from '../web/pages.js';
import { readGlances } from '../web/read.js';
import { adoptedPlugins, adoptPlugins, resetAdoptedPlugins } from './load.js';
import { loadPluginLive, unloadPluginLive } from './live.js';
import { setPluginEnabled, toggleNotes } from './toggle.js';

const dir = mkdtempSync(path.join(tmpdir(), 'buddi-live-'));
const entry = path.join(dir, 'index.js');
writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'garden', type: 'module' }));
// No imports, so it loads from a directory outside the workspace; no
// migrations, so enabling needs no database.
writeFileSync(
  entry,
  `export const manifest = {
  name: 'garden',
  version: '1.0.0',
  schema: 'garden',
  migrationsDir: '',
  tools: [{ name: 'garden.beds', description: 'The beds.', tier: 'auto',
    inputSchema: { type: 'object', properties: {} }, execute: async () => ({ beds: 3 }) }],
  pages: [{ id: 'beds', title: 'Garden', place: 'rail', body: [{ kind: 'notice', text: 'Beds.' }] }],
  home: [{ id: 'garden.now', title: 'Garden', placement: 'glance', produce: async () => ({ icon: 'dot', text: '3 beds' }) }],
  sources: [{ id: 'garden.poll', schedule: { everyMinutes: 60 }, poll: async () => [] }],
  sentinels: [{ id: 'garden.dry', schedule: { everyMinutes: 60 }, check: async () => [] }],
};
`,
);

const record: InstalledPlugin = {
  name: 'garden',
  version: '1.0.0',
  source: { kind: 'directory', path: dir },
  entry,
  installedAt: new Date(0).toISOString(),
  schema: 'garden',
};

const otherTool = {
  name: 'memory.note',
  description: 'Note.',
  tier: 'auto' as const,
  inputSchema: { type: 'object' as const, properties: {} },
  execute: async () => ({}),
};

function fakePool() {
  return { query: async () => ({ rows: [] }) };
}

async function contributions(registry: ToolRegistry) {
  return {
    tools: registry.list().map((t) => t.name),
    pages: (listPageDescriptors({ registry, ctx: {} as never, now: () => new Date() }).body as { pages: Array<{ plugin: string }> }).pages.map((p) => p.plugin),
    glances: (await readGlances({ pool: fakePool() as never, registry, ctx: {} as never })).map((g) => g.id),
    sources: collectSources(registry.manifests()).map((s) => s.id),
    sentinels: collectSentinels(registry.manifests()).map((s) => s.id),
  };
}

afterEach(() => resetAdoptedPlugins());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a plugin disabled and enabled while buddi runs', () => {
  it('leaves the registry and every read of it at once, and comes back the way boot loads it', async () => {
    const env = { ...process.env };
    const registry = new ToolRegistry();
    registry.register({ name: 'memory', version: '1', schema: 'memory', migrationsDir: '', tools: [otherTool] });
    const first = await loadPluginLive(record, { registry, env });
    expect(first).toEqual({ applied: true });
    adoptPlugins(env, { file: 'plugins.json', loaded: [], problems: [] });
    expect(await contributions(registry)).toEqual({
      tools: ['memory.note', 'garden.beds'],
      pages: ['garden'],
      glances: ['garden.now'],
      sources: ['garden.poll'],
      sentinels: ['garden.dry'],
    });

    let changes = 0;
    registry.onChange(() => (changes += 1));
    expect(unloadPluginLive(record, { registry, env })).toEqual({ applied: true });
    expect(await contributions(registry)).toEqual({ tools: ['memory.note'], pages: [], glances: [], sources: [], sentinels: [] });
    await Promise.resolve();
    // The catalog is rebuilt on this, so every agent's grants re-resolve for its next turn.
    expect(changes).toBe(1);
    expect(adoptedPlugins(env)?.disabled?.map((r) => r.name)).toEqual(['garden']);

    // An agent granted the family carries on without it on the next resolve.
    const grants = resolveToolGrants(['garden.*', 'memory.note'], registry, 'gardener', new Set(['garden']));
    expect(grants).toEqual({ tools: ['memory.note'], missingFamilies: [], disabledFamilies: ['garden'] });

    expect(await loadPluginLive(record, { registry, env })).toEqual({ applied: true });
    expect((await contributions(registry)).tools).toEqual(['memory.note', 'garden.beds']);
    expect((await contributions(registry)).pages).toEqual(['garden']);
    expect(adoptedPlugins(env)?.loaded.map((p) => p.record.name)).toEqual(['garden']);
    expect(adoptedPlugins(env)?.disabled).toBeUndefined();
    expect(resolveToolGrants(['garden.*'], registry, 'gardener').tools).toEqual(['garden.beds']);
  });

  it('says it is done, with no restart, when the running registry took the change', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'buddi-live-owner-'));
    const file = path.join(root, 'plugins.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BUDDI_AGENTS_DIR: path.join(root, 'agents'),
      BUDDI_SKILLS_DIR: path.join(root, 'skills'),
      BUDDI_PLUGINS_FILE: file,
    };
    try {
      writeFileSync(file, JSON.stringify({ version: 1, plugins: [record] }));
      const registry = new ToolRegistry();
      await loadPluginLive(record, { registry, env });

      const off = await setPluginEnabled('garden', false, { env, registry });
      expect(off.restartNeeded).toBe(false);
      expect(toggleNotes(off)[0]).toBe('Disabled. Its tools, pages and watchers are off now; its data is kept.');
      expect(registry.list()).toEqual([]);

      const on = await setPluginEnabled('garden', true, { env, registry });
      expect(on.restartNeeded).toBe(false);
      expect(toggleNotes(on)[0]).toBe('Enabled.');
      expect(registry.list().map((t) => t.name)).toEqual(['garden.beds']);

      // The CLI with no gateway running: the record is all there is, and the next start reads it.
      const quiet = await setPluginEnabled('garden', false, { env, gatewayRunning: false });
      expect(quiet.restartNeeded).toBe(false);
      // With one running that could not be asked, it says what a restart finishes.
      const loud = await setPluginEnabled('garden', true, { env });
      expect(toggleNotes(loud).join(' ')).toMatch(/^Enabled\. Restart buddi to finish: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
