import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, symlink, chmod } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  atomicJson,
  browsersDir,
  browsersPath,
  dashboardReady,
  defaultDataDir,
  nativeEnvironment,
  playwrightCacheDir,
  readPrivateFile,
  reloadLaunchAgent,
} from './environment.js';

describe('the packaged installation environment', () => {
  test('platform data defaults and explicit override do not depend on cwd', () => {
    expect(defaultDataDir('darwin', {}, '/owner')).toBe('/owner/Library/Application Support/buddi');
    expect(defaultDataDir('linux', {}, '/owner')).toBe('/owner/.local/share/buddi');
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/data' }, '/owner')).toBe('/data/buddi');
    expect(defaultDataDir('win32', { LOCALAPPDATA: '/local' }, '/owner')).toBe('/local/buddi');
    expect(defaultDataDir('darwin', { BUDDI_DATA_DIR: '/isolated' }, '/owner')).toBe('/isolated');
  });

  test('the agents\' browser lives in the data directory, unless an existing install already fetched it', () => {
    expect(browsersDir('/data')).toBe('/data/browser/engines');
    expect(playwrightCacheDir('linux', {}, '/owner')).toBe('/owner/.cache/ms-playwright');
    expect(playwrightCacheDir('linux', { XDG_CACHE_HOME: '/cache' }, '/owner')).toBe('/cache/ms-playwright');
    expect(playwrightCacheDir('darwin', {}, '/owner')).toBe('/owner/Library/Caches/ms-playwright');
    const cache = (names: string[]) => (dir: string) => (dir === '/owner/.cache/ms-playwright' ? names : []);
    const base = { platform: 'linux', env: {}, home: '/owner' } as const;
    // A fresh machine: the data directory, created later by the installer.
    expect(browsersPath('/data', { ...base, exists: () => false, list: cache([]) })).toBe('/data/browser/engines');
    // An existing install with Chromium in Playwright's cache keeps it, so nothing is fetched again.
    expect(browsersPath('/data', { ...base, exists: () => false, list: cache(['chromium-1187', 'ffmpeg-1011']) })).toBeUndefined();
    // Only a Chromium build counts; FFmpeg alone is not a browser.
    expect(browsersPath('/data', { ...base, exists: () => false, list: cache(['ffmpeg-1011']) })).toBe('/data/browser/engines');
    // Once the data-directory location exists, it wins.
    expect(browsersPath('/data', { ...base, exists: (dir) => dir === '/data/browser/engines', list: cache(['chromium-1187']) })).toBe('/data/browser/engines');
    // A value the owner set is kept.
    expect(browsersPath('/data', { ...base, env: { PLAYWRIGHT_BROWSERS_PATH: '/mine' }, exists: () => true, list: cache([]) })).toBe('/mine');
  });

  test('a live supervisor excludes all competing starters; release permits another', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-lock-test-'));
    const release = await acquireLock(dir);
    await expect(acquireLock(dir)).rejects.toThrow(/already has a supervisor/);
    await release();
    const next = await acquireLock(dir); await next();
  });

  test('dead supervisor metadata is preserved and recovered', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-lock-test-'));
    await writeFile(path.join(dir, 'supervisor.lock'), '2147483647');
    const release = await acquireLock(dir);
    expect(await readFile(path.join(dir, 'supervisor.lock'), 'utf8')).toBe(String(process.pid));
    expect((await readdir(dir)).some(name => name.startsWith('supervisor.lock.stale-'))).toBe(true);
    await release();
  });

  test('recent incomplete lock fails closed instead of racing the owner', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-lock-test-'));
    await writeFile(path.join(dir, 'supervisor.lock'), '');
    await expect(acquireLock(dir)).rejects.toThrow(/already has a supervisor/);
  });

  test('atomic state replacement is readable and contains no leftover partial file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-state-test-'));
    const file = path.join(dir, 'installation.json');
    await atomicJson(file, { phase: 'provisioning' });
    await atomicJson(file, { phase: 'ready' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ phase: 'ready' });
    expect(await readdir(dir)).toEqual(['installation.json']);
  });

  test('native utility environment excludes credentials and injection variables', () => {
    expect(nativeEnvironment({ PATH: '/bin', HOME: '/owner', BUDDI_VAULT_KEY: 'secret', DATABASE_URL: 'secret', OPENAI_API_KEY: 'secret', PGOPTIONS: 'unsafe', NODE_OPTIONS: 'unsafe', DYLD_INSERT_LIBRARIES: 'unsafe' })).toEqual({ PATH: '/bin', HOME: '/owner' });
  });

  test('private files reject symlinks, non-files and permissive modes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-private-test-'));
    const file = path.join(dir, 'vault-key');
    expect(await readPrivateFile(file)).toBe(undefined);
    await writeFile(file, 'fixture', { mode: 0o600 });
    expect(await readPrivateFile(file)).toBe('fixture');
    const link = path.join(dir, '.env'); await symlink(file, link);
    await expect(readPrivateFile(link)).rejects.toThrow(/symbolic links/);
    await expect(readPrivateFile(dir)).rejects.toThrow(/regular file/);
    await chmod(file, 0o644);
    await expect(readPrivateFile(file)).rejects.toThrow(/owner-only/);
  });

  test('LaunchAgent replacement unloads old arguments before bootstrapping', async () => {
    const calls: string[][] = [];
    let prints = 0;
    await reloadLaunchAgent(async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'print' && ++prints === 2) throw Object.assign(new Error(), { code: 113, stderr: 'Could not find service' });
    }, 'gui/501', 'fixture', '/fixture.plist');
    expect(calls).toEqual([['launchctl', 'bootout', 'gui/501/fixture'], ['launchctl', 'print', 'gui/501/fixture'], ['launchctl', 'print', 'gui/501/fixture'], ['launchctl', 'bootstrap', 'gui/501', '/fixture.plist']]);
  });

  test('LaunchAgent reload tolerates only the absent-job error', async () => {
    let calls = 0;
    await reloadLaunchAgent(async () => { if (++calls === 1) throw Object.assign(new Error(), { code: 3, stderr: 'Boot-out failed: 3: No such process' }); }, 'gui/501', 'fixture', '/fixture');
    expect(calls).toBe(2);
    await expect(reloadLaunchAgent(async () => { throw Object.assign(new Error('denied'), { code: 5, stderr: 'Input/output error' }); }, 'gui/501', 'fixture', '/fixture')).rejects.toThrow(/denied/);
  });

  test('readiness rejects arbitrary 401s and proofs from another install', async () => {
    expect(await dashboardReady(4317, 'fixture', async () => new Response('', { status: 401 }))).toBe(false);
    expect(await dashboardReady(4317, 'fixture', async () => Response.json({ proof: 'wrong' }))).toBe(false);
    expect(await dashboardReady(4317, 'fixture', async url => {
      const challenge = new URL(url).searchParams.get('challenge');
      return Response.json({ proof: createHmac('sha256', 'fixture').update(`buddi-ready-v1:${challenge}`).digest('hex') });
    })).toBe(true);
  });
});
