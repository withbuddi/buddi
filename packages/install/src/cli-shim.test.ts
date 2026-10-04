/** buddi.app's command line tool against a fake machine; one real run of the shim it writes. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findNpmBuddi, installShim, readShim, shimDoctorLines, shimScript, shimsFor, SYSTEM_SHIM, userShim } from './cli-shim.js';
import type { ShimDeps } from './cli-shim.js';

const home = '/Users/owner';
const app = '/Applications/buddi.app';
const data = "/Users/owner/Library/Application Support/buddi";
const NODE = `${app}/Contents/Resources/runtime/node`;

function machine(opts: { files?: Record<string, string>; links?: Record<string, string>; rootRefuses?: boolean; adminDeclines?: boolean; path?: string[] } = {}) {
  const files = new Map(Object.entries(opts.files ?? { [NODE]: '' }));
  const written: string[] = [];
  const deps: ShimDeps = {
    home,
    searchPath: opts.path ?? ['/usr/bin', '/bin'],
    exists: (file) => files.has(file) || file in (opts.links ?? {}),
    realPath: (file) => opts.links?.[file] ?? (files.has(file) ? file : undefined),
    read: (file) => files.get(file),
    write: async (file, text) => {
      if (file === SYSTEM_SHIM && (opts.rootRefuses ?? true)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      written.push(`user ${file}`); files.set(file, text);
    },
    writeAsAdmin: async (file, text) => {
      if (opts.adminDeclines) throw new Error('User canceled.');
      written.push(`admin ${file}`); files.set(file, text);
    },
    remove: async (file) => { files.delete(file); },
    removeAsAdmin: async (file) => { files.delete(file); },
  };
  return { deps, files, written };
}

describe('the shim', () => {
  it('names the app and the data directory, and reads back what it names, quotes and all', () => {
    const odd = { app: "/Users/o'neil/Apps/buddi.app", data: "/Users/o'neil/Library/Application Support/buddi" };
    expect(readShim(shimScript(odd))).toEqual(odd);
    expect(readShim('#!/bin/sh\nexec node something\n')).toBeUndefined();
  });

  it('asks for an administrator once for /usr/local/bin/buddi', async () => {
    const m = machine();
    const done = await installShim({ app, data }, m.deps);
    expect(done).toMatchObject({ ok: true, file: SYSTEM_SHIM });
    expect(m.written).toEqual([`admin ${SYSTEM_SHIM}`]);
  });

  it('falls back to ~/.local/bin with a PATH hint when the prompt is declined', async () => {
    const m = machine({ adminDeclines: true });
    const done = await installShim({ app, data }, m.deps);
    expect(done).toMatchObject({ ok: true, file: userShim(home) });
    if (!done.ok) throw new Error('refused');
    expect(done.lines.join('\n')).toMatch(/not on your PATH yet/);
    const onPath = machine({ adminDeclines: true, path: ['/usr/bin', `${home}/.local/bin`] });
    const quiet = await installShim({ app, data }, onPath.deps);
    if (!quiet.ok) throw new Error('refused');
    expect(quiet.lines.join('\n')).not.toMatch(/PATH/);
  });

  it('refuses while npm\'s buddi is on PATH, and names it', async () => {
    const npm = '/opt/homebrew/bin/buddi';
    const m = machine({ links: { [npm]: '/opt/homebrew/lib/node_modules/@withbuddi/buddi/packages/install/dist/launcher.js' } });
    expect(findNpmBuddi(m.deps)).toBe(npm);
    const refused = await installShim({ app, data }, m.deps);
    expect(refused).toEqual({ ok: false, status: 409, error: `buddi is already installed from npm at ${npm}; remove it first for the app's copy: npm rm -g @withbuddi/buddi` });
    expect(m.written).toEqual([]);
  });

  it('leaves another program\'s buddi alone', async () => {
    const m = machine({ files: { [NODE]: '', [SYSTEM_SHIM]: '#!/bin/sh\necho somebody else\n' } });
    const refused = await installShim({ app, data }, m.deps);
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(m.files.get(SYSTEM_SHIM)).toContain('somebody else');
  });

  it('rewrites its own shim (a moved app) without asking again when it may', async () => {
    const m = machine({ rootRefuses: false, files: { [NODE]: '', [SYSTEM_SHIM]: shimScript({ app: '/Users/owner/Downloads/buddi.app', data }) } });
    expect(await installShim({ app, data }, m.deps)).toMatchObject({ ok: true });
    expect(readShim(m.files.get(SYSTEM_SHIM)!)).toEqual({ app, data });
  });

  it('doctor warns about a shim whose app is gone, with the fix', () => {
    const m = machine({ files: { [SYSTEM_SHIM]: shimScript({ app, data }) } });
    expect(shimDoctorLines(m.deps)).toEqual([`Warning: ${SYSTEM_SHIM} runs buddi.app at ${app}, which is not there any more. Open buddi.app and choose Install Command Line Tool again, or remove it: sudo rm ${SYSTEM_SHIM}`]);
    const fine = machine({ files: { [NODE]: '', [SYSTEM_SHIM]: shimScript({ app, data }) } });
    expect(shimDoctorLines(fine.deps)).toEqual([`Command line tool: ${SYSTEM_SHIM} runs buddi.app at ${app}.`]);
  });

  it('uninstall finds only the shims that run this installation', () => {
    const m = machine({ files: { [SYSTEM_SHIM]: shimScript({ app, data }), [userShim(home)]: shimScript({ app, data: '/elsewhere' }) } });
    expect(shimsFor(data, m.deps)).toEqual([SYSTEM_SHIM]);
  });
});

describe('the shim, run', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'buddi-shim-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function fakeApp(name: string): { app: string; data: string; shim: string } {
    const root = path.join(scratch, name);
    mkdirSync(root);
    const appDir = path.join(root, 'buddi.app');
    const runtime = path.join(appDir, 'Contents', 'Resources', 'runtime');
    mkdirSync(runtime, { recursive: true });
    // A "node" that prints what it was asked to run, and with which data directory.
    writeFileSync(path.join(runtime, 'node'), '#!/bin/sh\necho "data=$BUDDI_DATA_DIR launcher=$1 args=$2 $3"\n');
    chmodSync(path.join(runtime, 'node'), 0o755);
    const bundled = path.join(appDir, 'Contents', 'Resources', 'buddi', 'buddi-0.1.0', 'packages', 'install', 'dist');
    mkdirSync(bundled, { recursive: true });
    writeFileSync(path.join(bundled, 'launcher.js'), '');
    symlinkSync(path.join(appDir, 'Contents', 'Resources', 'buddi', 'buddi-0.1.0'), path.join(appDir, 'Contents', 'Resources', 'buddi', 'current'));
    const dataDir = path.join(root, 'data dir');
    mkdirSync(dataDir);
    const shim = path.join(root, 'buddi');
    writeFileSync(shim, shimScript({ app: appDir, data: dataDir }));
    chmodSync(shim, 0o755);
    return { app: appDir, data: dataDir, shim };
  }

  it('runs the bundle\'s copy, then the release buddi installed once current exists, always with the app\'s data directory', () => {
    const { app: appDir, data: dataDir, shim } = fakeApp('one');
    const first = spawnSync(shim, ['status', '--json'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(first.stdout.trim()).toBe(`data=${dataDir} launcher=${appDir}/Contents/Resources/buddi/current/packages/install/dist/launcher.js args=status --json`);
    const release = path.join(dataDir, 'releases', 'buddi-0.1.1', 'packages', 'install', 'dist');
    mkdirSync(release, { recursive: true });
    writeFileSync(path.join(release, 'launcher.js'), '');
    symlinkSync(path.join(dataDir, 'releases', 'buddi-0.1.1'), path.join(dataDir, 'releases', 'current'));
    const updated = spawnSync(shim, ['status'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', BUDDI_DATA_DIR: '/somewhere/else' } });
    expect(updated.stdout).toContain(`data=${dataDir} launcher=${dataDir}/releases/current/packages/install/dist/launcher.js`);
  });

  it('says so when the app is gone', () => {
    const { app: appDir, shim } = fakeApp('two');
    rmSync(appDir, { recursive: true, force: true });
    const gone = spawnSync(shim, ['status'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(gone.status).toBe(127);
    expect(gone.stderr).toMatch(/buddi\.app is no longer at/);
  });
});
