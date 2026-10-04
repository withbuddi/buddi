/**
 * Which installation a run is about (mode.ts), and the regression that made
 * it necessary: buddi.app's copy of the CLI run without its launcher took
 * itself for a checkout and purged the checkout's keychain.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AMBIGUOUS_LINE, detectMode, insideAppBundle, insideReleases, isGuarded, type ModeFacts } from './mode.js';
import { main } from './main.js';

const BUNDLE = '/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.0-pre.40/packages/cli/dist';
const RELEASE = '/Users/me/Library/Application Support/buddi/releases/buddi-0.1.0-pre.41/node_modules/@withbuddi/buddi/packages/cli/dist';
const CHECKOUT = '/Users/me/src/buddi/packages/cli/dist';

function facts(over: Partial<ModeFacts> & { files?: Record<string, string> } = {}): ModeFacts {
  const files = over.files ?? {};
  return {
    env: {},
    moduleDir: CHECKOUT,
    repoFound: true,
    repoRoot: '/Users/me/src/buddi',
    dataDir: '/Users/me/src/buddi/data',
    exists: (file) => file in files,
    read: (file) => files[file],
    ...over,
  };
}

describe('detectMode', () => {
  it('trusts the launcher: BUDDI_INSTALL_ROOT is a packaged install', () => {
    expect(detectMode(facts({ env: { BUDDI_INSTALL_ROOT: '/opt/buddi' }, moduleDir: BUNDLE, repoFound: false })).kind).toBe('packaged');
  });

  it('a checkout with its own data folder is a checkout', () => {
    expect(detectMode(facts()).kind).toBe('checkout');
  });

  it('a checkout pointed at a packaged installation\'s folder is ambiguous', () => {
    const mode = detectMode(facts({ files: { '/Users/me/src/buddi/data/installation.json': '{"version":1}' } }));
    expect(mode.kind).toBe('ambiguous');
  });

  it('the app bundle\'s code without its launcher is never a checkout', () => {
    const repoRoot = '/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.0-pre.40';
    const launcher = `${repoRoot}/packages/install/dist/launcher.js`;
    const mode = detectMode(facts({ moduleDir: BUNDLE, repoFound: false, repoRoot, files: { [launcher]: '' } }));
    expect(mode).toMatchObject({ kind: 'ambiguous', launcher });
    expect((mode as { why: string }).why).toMatch(/no BUDDI_DATA_DIR/);
  });

  it('with BUDDI_DATA_DIR naming an installation, it hands over to that release\'s launcher', () => {
    const repoRoot = '/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.0-pre.40';
    const launcher = `${repoRoot}/packages/install/dist/launcher.js`;
    const data = '/Users/me/Library/Application Support/buddi';
    const mode = detectMode(facts({
      env: { BUDDI_DATA_DIR: data }, moduleDir: BUNDLE, repoFound: false, repoRoot,
      files: { [launcher]: '', [`${data}/installation.json`]: '{"version":1}' },
    }));
    expect(mode).toEqual({ kind: 'delegate', launcher, data });
  });

  it('with BUDDI_DATA_DIR naming a folder that is not an installation, it is ambiguous', () => {
    const mode = detectMode(facts({ env: { BUDDI_DATA_DIR: '/tmp/empty' }, moduleDir: RELEASE, repoFound: false }));
    expect(mode.kind).toBe('ambiguous');
    expect((mode as { why: string }).why).toMatch(/not a buddi installation/);
  });

  it('knows a bundle and a release folder when it sees one', () => {
    expect(insideAppBundle(BUNDLE)).toBe(true);
    expect(insideAppBundle('/Users/x/Downloads/buddi.app/Contents/MacOS')).toBe(true);
    expect(insideAppBundle(CHECKOUT)).toBe(false);
    expect(insideReleases(RELEASE)).toBe(true);
    expect(insideReleases('/x/releases/current/packages/cli/dist')).toBe(true);
    expect(insideReleases(CHECKOUT)).toBe(false);
  });

  it('guards the commands that stop or remove something', () => {
    expect(isGuarded(['uninstall', '--yes'])).toBe(true);
    for (const action of ['install', 'stop', 'uninstall']) expect(isGuarded(['service', action])).toBe(true);
    expect(isGuarded(['service', 'status'])).toBe(false);
    expect(isGuarded(['status'])).toBe(false);
  });
});

describe('main refuses an ambiguous run of a guarded command before anything loads', () => {
  it('prints why and the one line, exits 2', async () => {
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
    const code = await main(['service', 'stop'], {}, { kind: 'ambiguous', why: 'Because.' });
    vi.restoreAllMocks();
    expect(code).toBe(2);
    expect(err).toEqual(['Because.', AMBIGUOUS_LINE]);
  });
});

/*
 * The exact command from 2026-10-04, against a copy of the built CLI laid out
 * as buddi.app lays it out, with HOME on a scratch folder. It has to refuse
 * and leave everything as it was. BUDDI_VAULT=memory is belt and braces: the
 * guard runs before any vault is opened, and a regression must not be able
 * to reach a real keychain from a test.
 */
describe('regression: the bundle\'s main.js run directly', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cliDir = path.resolve(here, '..');
  const built = path.join(cliDir, 'dist', 'main.js');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'buddi-mode-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function layApp(): { node: string; main: string; home: string; bundle: string } {
    const resources = path.join(scratch, 'buddi.app', 'Contents', 'Resources');
    const release = path.join(resources, 'buddi', 'buddi-0.1.0');
    const cli = path.join(release, 'packages', 'cli');
    mkdirSync(path.join(resources, 'runtime'), { recursive: true });
    mkdirSync(cli, { recursive: true });
    symlinkSync(process.execPath, path.join(resources, 'runtime', 'node'));
    cpSync(path.join(cliDir, 'dist'), path.join(cli, 'dist'), { recursive: true });
    cpSync(path.join(cliDir, 'package.json'), path.join(cli, 'package.json'));
    symlinkSync(path.join(cliDir, 'node_modules'), path.join(cli, 'node_modules'));
    writeFileSync(path.join(release, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version: '0.1.0' }));
    symlinkSync(release, path.join(resources, 'buddi', 'current'));
    const home = path.join(scratch, 'home');
    mkdirSync(home);
    return { node: path.join(resources, 'runtime', 'node'), main: path.join(resources, 'buddi', 'current', 'packages', 'cli', 'dist', 'main.js'), home, bundle: release };
  }

  it.skipIf(!existsSync(built))('<app>/Resources/runtime/node <app>/Resources/buddi/current/packages/cli/dist/main.js uninstall --yes --no-backup refuses and touches nothing', () => {
    const app = layApp();
    const before = readdirSync(app.bundle).sort();
    const run = spawnSync(app.node, [app.main, 'uninstall', '--yes', '--no-backup'], {
      env: { HOME: app.home, PATH: '/usr/bin:/bin', BUDDI_VAULT: 'memory', TMPDIR: scratch },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(AMBIGUOUS_LINE);
    expect(run.stdout).not.toMatch(/Removed|keychain/);
    expect(readdirSync(app.home)).toEqual([]);
    expect(readdirSync(app.bundle).sort()).toEqual(before);

    // And with BUDDI_DATA_DIR on a folder that is not an installation: refused the same way.
    const empty = path.join(scratch, 'not-an-install');
    mkdirSync(empty);
    const named = spawnSync(app.node, [app.main, 'uninstall', '--yes', '--no-backup'], {
      env: { HOME: app.home, PATH: '/usr/bin:/bin', BUDDI_VAULT: 'memory', TMPDIR: scratch, BUDDI_DATA_DIR: empty },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(named.status).toBe(2);
    expect(named.stderr).toMatch(/is not a buddi installation/);
    expect(readdirSync(empty)).toEqual([]);
    expect(readdirSync(app.home)).toEqual([]);
  }, 90_000);
});
