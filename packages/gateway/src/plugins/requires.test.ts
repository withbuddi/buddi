/**
 * A plugin that requires another (docs/plugins.md §2.10): held back at load
 * while its requirement is missing, disabled or out of range; held back in the
 * running gateway while the requirement is not set up, and let in the moment
 * it is — its tools leaving and coming back with the registry, its data never
 * touched. And readiness itself: kept half a minute, a broken check logged
 * once and never holding anything back.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PLUGINS_FILE_VERSION, ToolRegistry, writePluginsFile, type CoreToolContext, type InstalledPlugin } from '@buddi/core';
import { adoptedPlugins, adoptPlugins, holdBack, loadManifest, resetAdoptedPlugins, staticNeeds, type LoadedPlugins } from './load.js';
import { createReadiness, needWords, reconcileRequirements } from './requires.js';
import { listPlugins, requirementStates } from '../web/plugins.js';

const root = mkdtempSync(path.join(tmpdir(), 'buddi-requires-'));

function writePlugin(name: string, version: string, body: string, buddi: Record<string, unknown> = {}): InstalledPlugin {
  const dir = path.join(root, `${name}-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', buddi }));
  writeFileSync(
    path.join(dir, 'index.js'),
    `export const manifest = { name: '${name}', version: '${version}', schema: '${name}', migrationsDir: '',
  tools: [{ name: '${name}.ping', description: 'Ping.', tier: 'auto', inputSchema: { type: 'object', properties: {} }, execute: async () => ({}) }],
  ${body} };\n`,
  );
  return { name, version, source: { kind: 'directory', path: dir }, entry: path.join(dir, 'index.js'), installedAt: new Date(0).toISOString(), schema: name };
}

const weather = writePlugin(
  'weather',
  '1.2.0',
  `pages: [{ id: 'settings', title: 'Weather', place: 'settings', body: [{ kind: 'notice', text: 'Places' }] }],
  setup: { produce: async () => ({ ready: globalThis.__weatherReady === true, note: 'Pick a place for the forecast.', page: 'settings' }) },`,
);
const oldWeather = writePlugin('weather', '0.9.0', '');
const commute = writePlugin('commute', '0.1.0', `requires: { weather: '^1.0.0' },`, { requires: { weather: '^1.0.0' } });
const liar = writePlugin('liar', '0.1.0', `requires: { weather: '^1.0.0' },`, { requires: { weather: '^2.0.0' } });

const env = {} as NodeJS.ProcessEnv;
const ctx = { db: { query: async () => ({ rows: [] }) }, now: () => new Date(), timezone: 'UTC', ownerId: 'owner' } as unknown as CoreToolContext;
const ready = (value: boolean): void => {
  (globalThis as { __weatherReady?: boolean }).__weatherReady = value;
};

async function loaded(record: InstalledPlugin) {
  const result = await loadManifest(record.entry, { name: record.name }, env);
  if (!result.ok) throw new Error(result.message);
  return { record, manifest: result.manifest, contribution: {} as never };
}

afterEach(() => resetAdoptedPlugins());
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('requires, at load', () => {
  it('refuses a plugin whose manifest and package.json disagree', async () => {
    const result = await loadManifest(liar.entry, { name: 'liar' }, env);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/requires weather \^1\.0\.0 in its manifest, and weather \^2\.0\.0 in package.json/);
  });

  it('holds a plugin back while what it requires is missing, disabled, failed or out of range', async () => {
    const c = await loaded(commute);
    const base: LoadedPlugins = { file: '', loaded: [c], problems: [] };
    expect(holdBack(base, env).waiting?.[0]?.needs).toEqual([{ plugin: 'weather', range: '^1.0.0', state: 'missing' }]);
    expect(staticNeeds(c.manifest, { ...base, disabled: [{ ...weather, enabled: false }] }, env)[0]).toMatchObject({ state: 'disabled', installed: '1.2.0' });
    expect(staticNeeds(c.manifest, { ...base, problems: [{ name: 'weather', entry: weather.entry, message: 'threw', record: weather }] }, env)[0]).toMatchObject({ state: 'failed' });
    const old = holdBack({ ...base, loaded: [await loaded(oldWeather), c] }, env);
    expect(old.loaded.map((p) => p.record.name)).toEqual(['weather']);
    expect(old.waiting?.[0]?.needs).toEqual([{ plugin: 'weather', range: '^1.0.0', state: 'range', installed: '0.9.0' }]);
    expect(needWords(old.waiting![0]!.needs[0]!)).toBe('Needs weather 1.0 or newer (0.9.0 is installed)');
    expect(holdBack({ ...base, loaded: [await loaded(weather), c] }, env).waiting).toBeUndefined();
  });

  it('tells the install card where each requirement stands', async () => {
    adoptPlugins(env, { file: '', loaded: [await loaded(oldWeather)], problems: [] });
    expect(requirementStates({ weather: '^1.0.0', speech: '*' }, env)).toEqual([
      { plugin: 'weather', range: '^1.0.0', rangeWords: '1.0 or newer', state: 'range', installed: '0.9.0', words: 'Needs weather 1.0 or newer (0.9.0 is installed)' },
      { plugin: 'speech', range: '*', rangeWords: 'any version', state: 'missing', words: 'Needs speech' },
    ]);
    adoptPlugins(env, { file: '', loaded: [await loaded(weather)], problems: [] });
    expect(requirementStates({ weather: '^1.0.0' }, env)[0]).toMatchObject({ state: 'ok', installed: '1.2.0' });
  });
});

describe('requires, while buddi runs', () => {
  it('holds a plugin back until what it requires is set up, then loads it, its tools following', async () => {
    ready(false);
    const w = await loaded(weather);
    const c = await loaded(commute);
    const registry = new ToolRegistry();
    registry.register(w.manifest);
    registry.register(c.manifest);
    adoptPlugins(env, { file: '', loaded: [w, c], problems: [] });
    const lines: string[] = [];
    const readiness = createReadiness({ registry, ctx, now: () => new Date(), log: (l) => lines.push(l) });
    const deps = { registry, readiness, env, log: (l: string) => lines.push(l) };

    expect(await reconcileRequirements(deps)).toEqual({ loaded: [], held: ['commute'] });
    expect(registry.list().map((t) => t.name)).toEqual(['weather.ping']);
    expect(adoptedPlugins(env)?.waiting?.[0]?.needs).toEqual([
      { plugin: 'weather', range: '^1.0.0', state: 'setup', installed: '1.2.0', note: 'Pick a place for the forecast.', page: 'settings' },
    ]);

    ready(true);
    // Kept half a minute: nothing moves until the answer is asked again.
    expect(await reconcileRequirements(deps)).toEqual({ loaded: [], held: [] });
    readiness.forget();
    expect(await reconcileRequirements(deps)).toEqual({ loaded: ['commute'], held: [] });
    expect(registry.list().map((t) => t.name).sort()).toEqual(['commute.ping', 'weather.ping']);
    expect(adoptedPlugins(env)?.waiting).toBeUndefined();

    // Its requirement disabled: out again.
    registry.unregister('weather');
    adoptPlugins(env, { file: '', loaded: [adoptedPlugins(env)!.loaded.find((p) => p.record.name === 'commute')!], problems: [], disabled: [{ ...weather, enabled: false }] });
    expect(await reconcileRequirements(deps)).toEqual({ loaded: [], held: ['commute'] });
    expect(registry.list().map((t) => t.name)).toEqual([]);
  });

  it('logs a broken setup once and treats it as no answer', async () => {
    const registry = { readiness: async () => { throw new Error('boom'); }, manifests: () => [] };
    const lines: string[] = [];
    const readiness = createReadiness({ registry, ctx, now: () => new Date(), log: (l) => lines.push(l) });
    expect(await readiness.of('weather')).toBeUndefined();
    readiness.forget();
    expect(await readiness.of('weather')).toBeUndefined();
    expect(lines).toEqual(["plugins: weather's setup check failed: boom"]);
  });
});

describe('the Plugins list', () => {
  it('says "Needs setup" with the note, and what a held-back plugin needs, without asking for a restart', async () => {
    ready(false);
    const file = path.join(root, 'plugins.json');
    writePluginsFile(file, { version: PLUGINS_FILE_VERSION, plugins: [weather, commute] });
    const listEnv = { BUDDI_PLUGINS_FILE: file } as NodeJS.ProcessEnv;
    const w = await loaded(weather);
    const c = await loaded(commute);
    const registry = new ToolRegistry();
    registry.register(w.manifest);
    registry.register(c.manifest);
    adoptPlugins(listEnv, { file, loaded: [w, c], problems: [] });
    const readiness = createReadiness({ registry, ctx, now: () => new Date(), log: () => {} });
    const reply = await listPlugins({
      env: listEnv,
      log: () => {},
      registry: Object.assign(registry, { networkOf: () => undefined }),
      requirements: { readiness, reconcile: () => reconcileRequirements({ registry, readiness, env: listEnv, log: () => {} }) },
      engine: { TRUST_SENTENCE: '', listStaged: () => [], pluginLoadReport: () => [] } as never,
    });
    const body = reply.body as { installed: Array<Record<string, any>>; restartNeeded: boolean };
    const row = (name: string) => body.installed.find((p) => p.name === name)!;
    expect(row('weather')).toMatchObject({ loaded: true, setup: { ready: false, note: 'Pick a place for the forecast.', page: { id: 'settings', place: 'settings' } } });
    expect(row('commute')).toMatchObject({ loaded: false, needs: [{ plugin: 'weather', state: 'setup', words: 'Needs setup in weather', page: { id: 'settings', place: 'settings' } }] });
    expect(row('commute').error).toBeUndefined();
    expect(body.restartNeeded).toBe(false);
  });
});
