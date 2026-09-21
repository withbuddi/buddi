/**
 * The verbs, and the one thing a parser here can get wrong that matters: a
 * flag that takes a value swallowing the next word, or an unknown flag passing
 * silently. `--purge` is in this set, and a `--purge` that was accepted when it
 * was meant as `--purged` would drop a schema.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './agents/catalog.js';
import { TRUST_SENTENCE } from './plugins/stage.js';
import { needsIntegrityFirst, parsePluginsArgs, USAGE } from './plugins-cli.js';
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

  it('documents every verb it parses', () => {
    for (const verb of ['list', 'info', 'install', 'update', 'staged', 'approve', 'reject', 'uninstall']) {
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
