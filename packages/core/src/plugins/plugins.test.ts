/**
 * The contribution summary and the install record.
 *
 * The summary is the only thing standing between an owner and running a
 * stranger's code, so what is tested is the part that has to be loud: tools at
 * tier `auto` run with nobody asked, and they are counted and listed
 * separately from everything else rather than folded into a total.
 *
 * The record is tested for one thing above all: a file it cannot parse is an
 * error, never an empty list. "Nothing is installed" is a claim, and inventing
 * it from a corrupt file would silently unregister every tool the owner's
 * agents are granted.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PluginManifest, ToolDefinition } from '../tools.js';
import { contributionHeadline, contributionOf, humanPeriod, renderContribution } from './contribution.js';
import {
  parsePluginsFile,
  PluginsFileError,
  pluginsFilePath,
  removeInstalledPlugin,
  upsertInstalledPlugin,
} from './record.js';
import { PLUGINS_FILE_VERSION, type InstalledPlugin } from './types.js';

function tool(name: string, tier: 'auto' | 'gated', description: string): ToolDefinition<any, any> {
  return {
    name,
    description,
    tier,
    input: z.object({}).strict(),
    async execute() {
      return {};
    },
  };
}

const manifest: PluginManifest = {
  name: 'garden',
  version: '1.0.0',
  description: 'Watches a garden.',
  schema: 'garden',
  migrationsDir: '/somewhere/migrations',
  tools: [
    tool('garden.plants', 'auto', 'Every plant the owner has recorded. Reads the garden schema.'),
    tool('garden.order_seeds', 'gated', 'Orders seeds from the shop, with the owner\'s card.'),
  ],
  sentinels: [{ id: 'garden.dry', description: 'Warns when a pot has not been watered.', every: 21_600, run: async () => [] }],
  sources: [{ id: 'garden.sensor', description: 'Polls the moisture sensor.', every: 900, poll: async () => {} }],
  missions: [{ id: 'watering', name: 'Watering', agentRole: 'garden', cron: '0 8 * * *', prompt: 'water' }],
  agents: [
    {
      id: 'gardener',
      handle: 'gardener',
      name: 'Gardener',
      description: 'Reads the log.',
      persona: 'You are the gardener.',
      tools: ['garden.*'],
      roles: ['garden'],
      skills: [{ name: 'when-a-plant-is-dry', description: 'Overdue.', body: 'Three days.' }],
    },
  ],
  skills: [{ name: 'reading-a-water-log', description: 'Gaps first.', body: 'Look at the gaps.' }],
  network: [{ host: 'seeds.example.com', why: 'the seed catalogue' }],
};

describe('what an owner sees before installing', () => {
  const contribution = contributionOf(manifest);

  it('separates the tools that run without asking from the ones that do not', () => {
    expect(contribution.autoTools.map((t) => t.name)).toEqual(['garden.plants']);
    expect(contribution.gatedTools.map((t) => t.name)).toEqual(['garden.order_seeds']);
  });

  it('says so in capitals, because it is the whole point of the summary', () => {
    const text = renderContribution(contribution).join('\n');
    expect(text).toContain('1 run WITHOUT ASKING YOU (tier auto)');
    expect(text).toContain('garden.plants — Every plant the owner has recorded.');
    expect(text).toContain('1 need your approval before they do anything');
  });

  it('names the schema it will own, the timers it will run, and the hosts it wants', () => {
    const text = renderContribution(contribution).join('\n');
    expect(text).toContain('It owns the Postgres schema "garden"');
    expect(text).toContain('garden.dry (watcher) — every 6 hours');
    expect(text).toContain('garden.sensor (source) — every 15 minutes');
    expect(text).toContain('seeds.example.com — the seed catalogue');
  });

  it('is honest that an undeclared host is not an enforced one', () => {
    const text = renderContribution(contributionOf({ ...manifest, network: [] })).join('\n');
    expect(text).toContain('Nothing enforces that');
  });

  it('shows the proposed agents with their grants, and says nothing is created', () => {
    const text = renderContribution(contribution).join('\n');
    expect(text).toContain('Gardener (@gardener)');
    expect(text).toContain('would be granted: garden.*');
    expect(text).toContain('Nothing here is created by installing.');
  });

  it('never claims core\'s schema as a plugin\'s own', () => {
    expect(contributionOf({ ...manifest, schema: 'core' }).schema).toBeUndefined();
    expect(renderContribution(contributionOf({ ...manifest, schema: 'core' })).join('\n')).toContain(
      'It owns no tables of its own.',
    );
  });

  it('gives one line for a list', () => {
    expect(contributionHeadline(contribution)).toBe(
      '2 tools, 1 auto, 2 on a timer, 1 agents proposed, 1 missions suggested',
    );
  });

  it('reads periods the way a person says them', () => {
    expect(humanPeriod(21_600)).toBe('every 6 hours');
    expect(humanPeriod(900)).toBe('every 15 minutes');
    expect(humanPeriod(86_400)).toBe('every 1 day');
    expect(humanPeriod(45)).toBe('every 45 seconds');
  });
});

describe('the install record', () => {
  const record: InstalledPlugin = {
    name: 'garden',
    version: '1.0.0',
    entry: '/plugins/garden/dist/index.js',
    schema: 'garden',
    installedAt: '2026-09-15T12:00:00.000Z',
    source: { kind: 'directory', path: '/plugins/garden' },
  };

  it('round-trips', () => {
    const contents = upsertInstalledPlugin({ version: PLUGINS_FILE_VERSION, plugins: [] }, record);
    expect(parsePluginsFile(JSON.stringify(contents)).plugins).toEqual([record]);
  });

  it('replaces a plugin in place on an upgrade, keeping the order', () => {
    const other = { ...record, name: 'other', schema: 'other' };
    const one = upsertInstalledPlugin({ version: PLUGINS_FILE_VERSION, plugins: [record, other] }, {
      ...record,
      version: '2.0.0',
    });
    expect(one.plugins.map((p) => `${p.name}@${p.version}`)).toEqual(['garden@2.0.0', 'other@1.0.0']);
  });

  it('removes one and says whether it was there', () => {
    expect(removeInstalledPlugin({ version: PLUGINS_FILE_VERSION, plugins: [record] }, 'garden')).toMatchObject({
      removed: true,
    });
    expect(removeInstalledPlugin({ version: PLUGINS_FILE_VERSION, plugins: [] }, 'garden').removed).toBe(false);
  });

  it('refuses a file it cannot parse rather than reporting an empty installation', () => {
    expect(() => parsePluginsFile('{oh no')).toThrow(PluginsFileError);
    expect(() => parsePluginsFile('{"version":99,"plugins":[]}')).toThrow(/version 99/);
    expect(() => parsePluginsFile('{"version":1,"plugins":[{"name":"x"}]}')).toThrow(/has no "version"/);
    expect(() => parsePluginsFile('{"version":1,"plugins":[]}').plugins).not.toThrow();
  });

  it('refuses two records for one plugin', () => {
    const two = JSON.stringify({ version: 1, plugins: [record, record] });
    expect(() => parsePluginsFile(two)).toThrow(/twice/);
  });

  it('lives in the owner\'s private directory, and is pinnable', () => {
    expect(pluginsFilePath({ ownerRoot: '/home/me/.buddi' })).toBe('/home/me/.buddi/plugins.json');
    expect(pluginsFilePath({ ownerRoot: '/home/me/.buddi', env: { BUDDI_PLUGINS_FILE: '/tmp/p.json' } })).toBe(
      '/tmp/p.json',
    );
  });
});
