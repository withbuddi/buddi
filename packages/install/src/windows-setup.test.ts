/**
 * The Windows setup's program against a folder: the backup by the buddi that
 * serves the data, the stop before the switch, the upgrade marker, the
 * runtime swap, the rollback of a release that does not start, and the
 * takeover of an npm install. Processes are fakes (InstallDeps); the files,
 * the links and the state are real, in a temp folder (links are junctions on
 * Windows, symlinks elsewhere).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { pointAt, releaseDir, releaseRoot } from './app-layout.js';
import { buildWindowsCommand } from './windows-install.js';
import { Said, SetupError, install, lastKeptBackup, parseSetupArgs } from './windows-setup.js';
import type { InstallDeps, Run } from './windows-setup.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-winsetup-')));
  dirs.push(dir);
  return dir;
}

async function releaseIn(prefix: string, version: string): Promise<string> {
  const root = releaseRoot(prefix);
  await mkdir(path.join(root, 'packages', 'install', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version }));
  await writeFile(path.join(root, 'packages', 'install', 'dist', 'launcher.js'), '// launcher');
  return root;
}

async function bundle(at: string, version: string, node = 'v22.23.3'): Promise<string> {
  const dir = path.join(at, `.install-x`, `buddi-${version}-windows-x64`);
  await mkdir(path.join(dir, 'runtime'), { recursive: true });
  await writeFile(path.join(dir, 'runtime', 'node.exe'), `node ${node}`);
  await writeFile(path.join(dir, 'runtime', 'VERSION'), `${node}\n`);
  await writeFile(path.join(dir, 'VERSION'), `${version}\n`);
  await releaseIn(path.join(dir, 'release'), version);
  return dir;
}

/** An installation of the setup's own: a release under current, the runtime, installation.json, the command. */
async function installed(data: string, bin: string, version: string, node = 'v22.23.3'): Promise<string> {
  const root = await releaseIn(releaseDir(path.join(data, 'releases'), version), version);
  await pointAt(path.join(data, 'releases', 'current'), root);
  await mkdir(path.join(data, 'node'), { recursive: true });
  await writeFile(path.join(data, 'node', 'node.exe'), `node ${node}`);
  await writeFile(path.join(data, 'node', 'VERSION'), `${node}\n`);
  await writeFile(path.join(data, 'installation.json'), JSON.stringify({ version: 1, database: 'managed', webPort: 4317, dbPort: 5555, phase: 'ready' }));
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'buddi.cmd'), buildWindowsCommand(data));
  return root;
}

interface Fake { deps: InstallDeps; calls: string[]; running: boolean }

function fake(data: string, opts: { running?: boolean; start?: number; npmDirs?: string[]; otherScripts?: string[]; root?: () => string | undefined } = {}): Fake {
  const f: Fake = { calls: [], running: opts.running ?? false, deps: undefined as unknown as InstallDeps };
  const ok = (output = ''): Run => ({ code: 0, output });
  const act = async (who: string, argv: string[]): Promise<Run> => {
    f.calls.push(`${who} ${argv.join(' ')}`);
    if (argv[0] === 'backup') {
      await mkdir(path.join(data, 'backups'), { recursive: true });
      await writeFile(path.join(data, 'backups', 'buddi-backup-1.tar.gz.age'), 'archive');
      return ok();
    }
    if (argv.includes('--no-service')) { f.running = true; return ok(); }
    if (argv[0] === '--no-open') {
      if (who === 'new' && opts.start !== undefined && opts.start !== 0) { f.running = true; return { code: opts.start, output: 'Startup did not finish.' }; }
      f.running = true;
      return ok('Starting buddi.\nDashboard: http://127.0.0.1:4317/#t=secret');
    }
    return ok();
  };
  f.deps = {
    status: async () => (f.running ? { installRoot: opts.root?.() ?? '' } : undefined),
    stop: async () => { f.calls.push('stop'); f.running = false; },
    runRelease: (_data, root, argv) => act(path.basename(root) === 'current' ? 'new' : `release:${path.basename(path.dirname(path.dirname(path.dirname(root))))}`, argv),
    runNpm: (_cmd, _data, argv) => act('npm', argv),
    pathDirs: () => opts.npmDirs ?? [],
    otherTaskScripts: async () => opts.otherScripts ?? [],
  };
  return f;
}

const quiet = (): Said => new Said(undefined);
const target = async (link: string): Promise<string> => path.resolve(path.dirname(link), await readlink(link));
const args = (b: string, data: string, bin: string, more: string[] = []) => parseSetupArgs(['install', '--bundle', b, '--data', data, '--bin', bin, ...more]);

describe('the setup over an installed buddi', () => {
  test('backs up with the running release, stops it, records the switch, and starts the new one', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    const old = await installed(data, bin, '0.1.0-pre.54');
    const f = fake(data, { running: true });
    const b = await bundle(data, '0.1.0-pre.55');
    expect(await install(args(b, data, bin), quiet(), f.deps)).toBe(0);
    expect(f.calls).toEqual(['release:buddi-0.1.0-pre.54 backup create', 'stop', 'new --no-open']);
    expect(await target(path.join(data, 'releases', 'current'))).toBe(releaseRoot(releaseDir(path.join(data, 'releases'), '0.1.0-pre.55')));
    expect(await target(path.join(data, 'releases', 'previous'))).toBe(old);
    const state = JSON.parse(await readFile(path.join(data, 'installation.json'), 'utf8')) as { phase: string; upgrade: { from: string; to: string; backup: string } };
    expect(state.phase).toBe('upgrading');
    expect(state.upgrade).toMatchObject({ from: '0.1.0-pre.54', to: '0.1.0-pre.55', backup: 'buddi-backup-1.tar.gz.age' });
    expect(JSON.parse(await readFile(path.join(data, 'installer.json'), 'utf8'))).toMatchObject({ version: '0.1.0-pre.55', command: path.join(bin, 'buddi.cmd') });
  });

  test('a stopped buddi is started briefly for the backup', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    await installed(data, bin, '0.1.0-pre.54');
    const f = fake(data);
    expect(await install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), f.deps)).toBe(0);
    expect(f.calls.slice(0, 3)).toEqual(['release:buddi-0.1.0-pre.54 --no-service --no-open', 'release:buddi-0.1.0-pre.54 backup create', 'stop']);
  });

  test('a release that does not start is rolled back: links, state, command, the new files, then the old one runs again', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    const old = await installed(data, bin, '0.1.0-pre.54');
    const stateBefore = await readFile(path.join(data, 'installation.json'), 'utf8');
    const commandBefore = await readFile(path.join(bin, 'buddi.cmd'), 'utf8');
    const f = fake(data, { running: true, start: 1 });
    await expect(install(args(await bundle(data, '0.1.0-pre.55', 'v22.24.0'), data, bin), quiet(), f.deps)).rejects.toThrow(SetupError);
    expect(f.calls).toEqual(['release:buddi-0.1.0-pre.54 backup create', 'stop', 'new --no-open', 'stop', 'release:buddi-0.1.0-pre.54 --no-open']);
    expect(await target(path.join(data, 'releases', 'current'))).toBe(old);
    expect(existsSync(path.join(data, 'releases', 'previous'))).toBe(false);
    expect(existsSync(releaseDir(path.join(data, 'releases'), '0.1.0-pre.55'))).toBe(false);
    expect(await readFile(path.join(data, 'installation.json'), 'utf8')).toBe(stateBefore);
    expect(await readFile(path.join(bin, 'buddi.cmd'), 'utf8')).toBe(commandBefore);
    // The runtime swapped for the new Node is the old one again.
    expect(await readFile(path.join(data, 'node', 'VERSION'), 'utf8')).toBe('v22.23.3\n');
  });

  test('a failure after the switch (the command cannot be written) is rolled back too', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    const old = await installed(data, bin, '0.1.0-pre.54');
    await rm(bin, { recursive: true });
    await writeFile(bin, 'a file where the folder goes');
    const f = fake(data, { running: true });
    await expect(install(args(await bundle(data, '0.1.0-pre.55', 'v22.24.0'), data, bin), quiet(), f.deps)).rejects.toThrow(/Putting back|is back/);
    expect(await target(path.join(data, 'releases', 'current'))).toBe(old);
    expect(await readFile(path.join(data, 'node', 'VERSION'), 'utf8')).toBe('v22.23.3\n');
    expect(JSON.parse(await readFile(path.join(data, 'installation.json'), 'utf8'))).toMatchObject({ phase: 'ready' });
    expect(f.calls.at(-1)).toBe('release:buddi-0.1.0-pre.54 --no-open');
  });

  test('the same release again refreshes without a backup or a switch', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    await installed(data, bin, '0.1.0-pre.55');
    const f = fake(data, { running: true });
    expect(await install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), f.deps)).toBe(0);
    expect(f.calls).toEqual(['new --no-open']);
  });
});

describe('the setup over data kept by an uninstall ("Keep my data for a reinstall")', () => {
  /** What `buddi uninstall --keep-data` leaves: the data, its database, its last backup, and no program. */
  async function kept(data: string, marked: boolean): Promise<void> {
    await mkdir(path.join(data, 'postgres'), { recursive: true });
    await writeFile(path.join(data, 'postgres', 'PG_VERSION'), '17\n');
    await writeFile(path.join(data, 'installation.json'), JSON.stringify({ version: 1, database: 'managed', webPort: 4317, dbPort: 5555, phase: 'ready' }));
    await mkdir(path.join(data, 'backups'), { recursive: true });
    await writeFile(path.join(data, 'backups', 'buddi-backup-20261012-120000.tar.gz.age'), 'archive');
    if (marked) await writeFile(path.join(data, 'kept-for-reinstall.json'), '{"keptAt":"2026-10-12T12:00:00.000Z"}');
  }

  test.each([true, false])('installs on it, says why no new backup is taken and where the last one is, and starts buddi on it (marker: %s)', async (marked) => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    await kept(data, marked);
    const f = fake(data);
    const said = quiet();
    expect(await install(args(await bundle(data, '0.1.0-pre.55'), data, bin), said, f.deps)).toBe(0);
    expect(f.calls.some(call => call.includes('backup'))).toBe(false);
    expect(f.calls.at(-1)).toBe('new --no-open');
    expect(said.lines.join('\n')).toMatch(/No new backup first: the buddi that wrote this data was removed/);
    expect(said.lines.join('\n')).toContain(path.join(data, 'backups', 'buddi-backup-20261012-120000.tar.gz.age'));
    // The data is untouched, and an installation's again.
    expect(await readFile(path.join(data, 'postgres', 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(existsSync(path.join(data, 'kept-for-reinstall.json'))).toBe(false);
    expect(await target(path.join(data, 'releases', 'current'))).toBe(releaseRoot(releaseDir(path.join(data, 'releases'), '0.1.0-pre.55')));
  });

  test('the last backup is the newest of the data folder\'s backups and buddi-backups (where the dashboard\'s removal keeps it)', () => {
    const lists: Record<string, Array<{ name: string; mtimeMs: number }>> = {
      '/d/backups': [{ name: 'buddi-backup-1.tar.gz.age', mtimeMs: 1 }],
      '/h/buddi-backups': [{ name: 'buddi-backup-2.tar.gz.age', mtimeMs: 2 }, { name: 'buddi-backup-2.tar.gz.age.passphrase.txt', mtimeMs: 3 }],
    };
    expect(lastKeptBackup(['/d/backups', '/h/buddi-backups'], dir => lists[dir] ?? [])).toBe(path.join('/h/buddi-backups', 'buddi-backup-2.tar.gz.age'));
    expect(lastKeptBackup(['/none'], () => [])).toBeUndefined();
  });

  test('a data folder that is not one an uninstall kept still asks for /SKIPBACKUP', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'installation.json'), JSON.stringify({ version: 1, database: 'managed', webPort: 4317, dbPort: 5555, phase: 'ready' }));
    await expect(install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), fake(data).deps)).rejects.toThrow(/SKIPBACKUP/);
  });
});

describe('the setup over an npm install', () => {
  async function npmCopy(dir: string, data: string): Promise<{ prefix: string; pkg: string }> {
    const prefix = path.join(dir, 'npm');
    const pkg = path.join(prefix, 'node_modules', '@withbuddi', 'buddi');
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version: '0.1.0-pre.53' }));
    await writeFile(path.join(prefix, 'buddi.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\@withbuddi\\buddi\\packages\\install\\dist\\launcher.js" %*\r\n');
    await mkdir(path.join(data, 'service'), { recursive: true });
    await writeFile(path.join(data, 'service', 'supervise.cmd'), `"node.exe" "${pkg}${path.sep}packages${path.sep}install${path.sep}dist${path.sep}launcher.js" supervise`);
    await writeFile(path.join(data, 'installation.json'), JSON.stringify({ version: 1, database: 'managed', webPort: 4317, dbPort: 5555, phase: 'ready' }));
    return { prefix, pkg };
  }

  test('moves over with npm\'s backup, and removes the npm copy once nothing else runs it', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    const { prefix, pkg } = await npmCopy(dir, data);
    const f = fake(data, { running: true, npmDirs: [prefix], root: () => pkg });
    expect(await install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), f.deps)).toBe(0);
    expect(f.calls).toEqual(['npm backup create', 'stop', 'new --no-open']);
    expect(JSON.parse(await readFile(path.join(data, 'installation.json'), 'utf8'))).toMatchObject({ phase: 'upgrading', upgrade: { from: '0.1.0-pre.53', to: '0.1.0-pre.55' } });
    expect(existsSync(pkg)).toBe(false);
    expect(existsSync(path.join(prefix, 'buddi.cmd'))).toBe(false);
  });

  test('keeps the npm copy when another installation\'s task runs it', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    const { prefix, pkg } = await npmCopy(dir, data);
    const f = fake(data, { running: true, npmDirs: [prefix], otherScripts: [`"node.exe" "${pkg}${path.sep}packages${path.sep}install${path.sep}dist${path.sep}launcher.js" supervise`] });
    expect(await install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), f.deps)).toBe(0);
    expect(existsSync(pkg)).toBe(true);
  });

  test('a failed start puts npm\'s buddi back, links gone, so running the setup again is a move with a backup again', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    const { prefix, pkg } = await npmCopy(dir, data);
    const stateBefore = await readFile(path.join(data, 'installation.json'), 'utf8');
    const f = fake(data, { running: true, start: 1, npmDirs: [prefix], root: () => pkg });
    await expect(install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), f.deps)).rejects.toThrow(SetupError);
    expect(f.calls).toEqual(['npm backup create', 'stop', 'new --no-open', 'stop', 'npm --no-open']);
    expect(existsSync(path.join(data, 'releases', 'current'))).toBe(false);
    expect(existsSync(path.join(bin, 'buddi.cmd'))).toBe(false);
    expect(await readFile(path.join(data, 'installation.json'), 'utf8')).toBe(stateBefore);
    expect(existsSync(pkg)).toBe(true);
    const again = fake(data, { running: true, npmDirs: [prefix], root: () => pkg });
    expect(await install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), again.deps)).toBe(0);
    expect(again.calls[0]).toBe('npm backup create');
  });

  test('refuses data that nothing here can back up, and changes nothing', async () => {
    const dir = await scratch(); const data = path.join(dir, 'data'); const bin = path.join(dir, 'bin');
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'installation.json'), '{}');
    const f = fake(data);
    await expect(install(args(await bundle(data, '0.1.0-pre.55'), data, bin), quiet(), f.deps)).rejects.toThrow(/no buddi here can back it up/);
    expect(existsSync(path.join(data, 'releases'))).toBe(false);
    expect(f.calls).toEqual([]);
  });
});
