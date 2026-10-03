/**
 * The verbs, and the one thing a parser here can get wrong that matters: a
 * flag that takes a value swallowing the next word, or an unknown flag passing
 * silently. `--purge` is in this set, and a `--purge` that was accepted when it
 * was meant as `--purged` would drop a schema.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './agents/catalog.js';
import { listStaged, TRUST_SENTENCE } from './plugins/stage.js';
import { describeSpec, needsIntegrityFirst, parsePluginsArgs, USAGE, widgetClaims } from './plugins-cli.js';
import type { PluginManifest } from '@buddi/core';
import type { StagedPlugin } from './plugins/stage.js';

describe('buddi plugins', () => {
  it('reads the verbs a plugin has a lifecycle for', () => {
    expect(parsePluginsArgs([]).command).toBe('help');
    expect(parsePluginsArgs(['list']).command).toBe('list');
    expect(parsePluginsArgs(['staged']).command).toBe('staged');
    expect(parsePluginsArgs(['install', 'buddi-plugin-weather'])).toMatchObject({
      command: 'install',
      target: 'buddi-plugin-weather',
      yes: false,
    });
    expect(parsePluginsArgs(['update', 'weather', '--version', '2.0.0', '--yes'])).toMatchObject({
      command: 'update',
      target: 'weather',
      version: '2.0.0',
      yes: true,
    });
    expect(parsePluginsArgs(['approve', 'abc123', '--integrity=sha512-x'])).toMatchObject({
      command: 'approve',
      target: 'abc123',
      integrity: 'sha512-x',
    });
    expect(parsePluginsArgs(['reject', 'abc123']).command).toBe('reject');
  });

  it('takes the name back for a purge', () => {
    expect(parsePluginsArgs(['uninstall', 'weather', '--yes', '--purge', '--confirm', 'weather'])).toMatchObject({
      purge: true,
      confirm: 'weather',
    });
  });

  it('keeps the two destructive flags apart from everything else', () => {
    expect(parsePluginsArgs(['uninstall', 'weather', '--yes', '--purge'])).toMatchObject({
      purge: true,
      yes: true,
    });
    expect(() => parsePluginsArgs(['uninstall', 'weather', '--purged'])).toThrow(/unknown option/);
  });

  it('refuses a value flag with nothing after it', () => {
    expect(() => parsePluginsArgs(['approve', 'abc', '--integrity'])).toThrow(/needs a value/);
  });

  it('says what each verb needs when it is not given one', () => {
    expect(() => parsePluginsArgs(['install'])).toThrow(/a directory, a .tgz, or an npm package/);
    expect(() => parsePluginsArgs(['approve'])).toThrow(/staging id/);
    expect(() => parsePluginsArgs(['info'])).toThrow(/plugin name/);
    expect(() => parsePluginsArgs(['frobnicate'])).toThrow(/unknown command/);
  });

  it('disables and enables by name', () => {
    expect(parsePluginsArgs(['disable', 'finance'])).toMatchObject({ command: 'disable', target: 'finance' });
    expect(parsePluginsArgs(['enable', 'finance'])).toMatchObject({ command: 'enable', target: 'finance' });
    expect(() => parsePluginsArgs(['disable'])).toThrow(/plugin name/);
  });

  it('takes the author for init', () => {
    expect(parsePluginsArgs(['init', 'garden', '--author', 'Ada'])).toMatchObject({ command: 'init', author: 'Ada' });
  });

  it('documents every verb it parses', () => {
    for (const verb of ['list', 'info', 'install', 'update', 'staged', 'approve', 'reject', 'disable', 'enable', 'uninstall']) {
      expect(USAGE).toContain(`buddi plugins ${verb}`);
    }
  });

  /**
   * One sentence, one source. It is shown by the CLI, by the Plugins page and
   * by the release smoke, and a copy that drifted would be a copy that no
   * longer said what the owner is agreeing to.
   */
  it('says the trust sentence the same way the documentation does', () => {
    const docs = readFileSync(path.join(REPO_ROOT, 'docs', 'plugins.md'), 'utf8');
    expect(docs.replace(/\n> /g, ' ')).toContain(TRUST_SENTENCE);
  });
});

/**
 * `--yes` cannot be approval 1 for a package that came from somewhere else.
 *
 * Typed before the fetch, it agrees to a hash nobody has seen — including the
 * person typing it. So for a registry or a tarball source it stages, prints
 * and stops, and the approval carries the hash back. A directory source has no
 * hash to carry and keeps the flow it always had.
 */
describe('--yes and the hash it has to carry', () => {
  const staged = (over: Partial<StagedPlugin>): StagedPlugin =>
    ({
      id: 'stage-1',
      dir: '/d',
      packageDir: '/d/package',
      createdAt: 'now',
      name: 'weather',
      version: '1.0.0',
      source: { kind: 'registry', name: 'weather', version: '1.0.0' },
      integrity: 'sha512-AAAA',
      stagedHash: 'sha256-beef',
      declaredName: 'weather',
      scripts: [],
      dependencies: { count: 0, withScripts: [] },
      claims: { hosts: [], text: '', missing: true },
      state: 'staged',
      ...over,
    }) as StagedPlugin;
  const args = (over: Partial<ReturnType<typeof parsePluginsArgs>>) =>
    ({ command: 'install', yes: false, detachAgents: false, purge: false, acknowledgeDrift: false, ...over }) as ReturnType<
      typeof parsePluginsArgs
    >;

  it('stops a --yes with no --integrity for a registry or a tarball', () => {
    expect(needsIntegrityFirst(staged({}), args({ yes: true }))).toBe(true);
    expect(
      needsIntegrityFirst(staged({ source: { kind: 'tarball', path: '/p.tgz' } }), args({ yes: true })),
    ).toBe(true);
    expect(needsIntegrityFirst(staged({}), args({ yes: true, integrity: 'sha512-AAAA' }))).toBe(false);
  });

  it('leaves the developer path alone', () => {
    expect(
      needsIntegrityFirst(staged({ source: { kind: 'directory', path: '/p' }, integrity: '' }), args({ yes: true })),
    ).toBe(false);
  });
});

describe('buddi plugins list --json', () => {
  it('is read on list, and refused elsewhere', () => {
    expect(parsePluginsArgs(['list', '--json']).json).toBe(true);
    expect(() => parsePluginsArgs(['info', 'finance', '--json'])).toThrow(/--json only applies to list and describe/);
  });
});

/**
 * `describe` is what a market listing's claims are made of: it stages, imports
 * the manifest, prints, and deletes the stage. It never writes the record.
 */
describe('buddi plugins describe', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const FIXTURE = path.join(HERE, 'plugins', 'fixtures', 'marker-plugin');
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'buddi-describe-'));
    mkdirSync(path.join(root, 'agents'), { recursive: true });
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    env = {
      ...process.env,
      BUDDI_DATA_DIR: path.join(root, 'data'),
      BUDDI_AGENTS_DIR: path.join(root, 'agents'),
      BUDDI_SKILLS_DIR: path.join(root, 'skills'),
      BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('parses, and takes --json', () => {
    expect(parsePluginsArgs(['describe', '@withbuddi/plugin-weather@0.1.0', '--json'])).toMatchObject({
      command: 'describe',
      target: '@withbuddi/plugin-weather@0.1.0',
      json: true,
    });
    expect(() => parsePluginsArgs(['describe'])).toThrow(/plugin to describe/);
    expect(USAGE).toContain('buddi plugins describe');
  });

  it('prints the listing shape, and leaves no record and no stage behind', async () => {
    const lines: string[] = [];
    const code = await describeSpec(FIXTURE, { env, json: true, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    const out = JSON.parse(lines.join('\n'));
    expect(out.package).toMatchObject({
      name: 'buddi-plugin-fixture-marker',
      version: '1.0.0',
      buddiName: 'fixture-marker',
      uses: [],
      dependencies: { count: expect.any(Number) },
      scripts: [],
    });
    expect(out.claims).toEqual({ schema: 'fixture_marker', hosts: ['example.invalid'], missing: false });
    expect(out.manifest).toMatchObject({
      name: 'fixture-marker',
      schema: 'fixture_marker',
      author: { name: 'A fixture maker' },
      network: [{ host: 'example.invalid' }],
      tools: [{ name: 'fixture-marker.echo', tier: 'auto', ownerOnly: false }],
      sentinels: [],
      missions: [],
      agents: [],
      pages: [],
      views: 0,
      home: 0,
      widgets: [],
    });
    expect(out.drift).toEqual([]);
    expect(existsSync(path.join(root, 'plugins.json'))).toBe(false);
    expect(listStaged(env)).toEqual([]);
  });

  it('prints the card and the contribution for a person', async () => {
    const lines: string[] = [];
    await describeSpec(FIXTURE, { env, log: (line) => lines.push(line) });
    const text = lines.join('\n');
    expect(text).toContain('buddi-plugin-fixture-marker 1.0.0');
    expect(text).toContain('by        A fixture maker (https://example.invalid/maker)');
    expect(text).toContain('fixture-marker.echo');
    expect(text).toContain('Nothing\nwas installed');
    expect(listStaged(env)).toEqual([]);
  });
});

/** What a listing shows of a plugin's widgets: the market's Widgets filter and previews read this. */
describe('widgetClaims', () => {
  const produce = async () => null;
  const manifest = (widgets: unknown): PluginManifest =>
    ({ name: 'weather', version: '1.0.0', schema: 'weather', pages: [{ id: 'weather' }], widgets }) as unknown as PluginManifest;

  it('lists each widget with its sizes, its settings and its preview, checked like a body', () => {
    expect(
      widgetClaims(
        manifest([
          {
            id: 'weather.now',
            title: 'Weather',
            sizes: ['small', 'medium'],
            link: { page: 'weather' },
            settings: [
              { key: 'place', kind: 'select', label: 'Place', inTitle: true, options: async () => [] },
              { key: 'time', kind: 'timeFormat', label: 'Times' },
            ],
            preview: { kind: 'stat', icon: 'sun', value: '18°C', caption: 'Clear · Paris', extra: 'dropped' },
            produce,
          },
          { id: 'weather.spent', title: 'Spent', sizes: ['medium'], sensitive: true, produce },
        ]),
      ),
    ).toEqual([
      {
        id: 'weather.now',
        title: 'Weather',
        sizes: ['small', 'medium'],
        settings: [
          { key: 'place', kind: 'select', label: 'Place' },
          { key: 'time', kind: 'timeFormat', label: 'Times' },
        ],
        preview: { small: { kind: 'stat', icon: 'sun', value: '18°C', caption: 'Clear · Paris' }, medium: { kind: 'stat', icon: 'sun', value: '18°C', caption: 'Clear · Paris' } },
      },
      { id: 'weather.spent', title: 'Spent', sizes: ['medium'], sensitive: true, settings: [] },
    ]);
  });

  it('is empty without widgets, and refuses a declaration that would not load', () => {
    expect(widgetClaims(manifest(undefined))).toEqual([]);
    expect(() => widgetClaims(manifest([{ id: 'weather.now', title: 'W', sizes: ['small'], preview: { kind: 'chart' }, produce }]))).toThrow(/preview cannot be drawn/);
  });
});
