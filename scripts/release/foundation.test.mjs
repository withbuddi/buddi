import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, symlink, chmod } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { defaultDataDir, acquireLock, atomicJson, nativeEnvironment, readPrivateFile, reloadLaunchAgent, dashboardReady } from './environment.mjs';
import { controlToken, restartDelay } from './supervisor.mjs';
import { watchDatabase } from './postgres.mjs';

test('platform data defaults and explicit override do not depend on cwd', () => {
  assert.equal(defaultDataDir('darwin', {}, '/owner'), '/owner/Library/Application Support/buddi');
  assert.equal(defaultDataDir('linux', {}, '/owner'), '/owner/.local/share/buddi');
  assert.equal(defaultDataDir('linux', { XDG_DATA_HOME: '/data' }, '/owner'), '/data/buddi');
  assert.equal(defaultDataDir('win32', { LOCALAPPDATA: '/local' }, '/owner'), '/local/buddi');
  assert.equal(defaultDataDir('darwin', { BUDDI_DATA_DIR: '/isolated' }, '/owner'), '/isolated');
});

test('a live supervisor excludes all competing starters; release permits another', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-lock-test-'));
  const release = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /already has a supervisor/);
  await release();
  const next = await acquireLock(dir); await next();
});

test('dead supervisor metadata is preserved and recovered', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-lock-test-'));
  await writeFile(path.join(dir, 'supervisor.lock'), '2147483647');
  const release = await acquireLock(dir);
  assert.equal(await readFile(path.join(dir, 'supervisor.lock'), 'utf8'), String(process.pid));
  assert.ok((await readdir(dir)).some(name => name.startsWith('supervisor.lock.stale-')));
  await release();
});

test('recent incomplete lock fails closed instead of racing the owner', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-lock-test-'));
  await writeFile(path.join(dir, 'supervisor.lock'), '');
  await assert.rejects(acquireLock(dir), /already has a supervisor/);
});

test('atomic state replacement is readable and contains no leftover partial file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-state-test-'));
  const file = path.join(dir, 'installation.json');
  await atomicJson(file, { phase: 'provisioning' });
  await atomicJson(file, { phase: 'ready' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { phase: 'ready' });
  assert.deepEqual(await readdir(dir), ['installation.json']);
});

test('supervisor uses a distinct credential domain', () => {
  assert.notEqual(controlToken('dashboard-token'), 'dashboard-token');
  assert.notEqual(controlToken('dashboard-token'), controlToken('another-install'));
  assert.equal(controlToken('dashboard-token'), controlToken('dashboard-token'));
});

test('native utility environment excludes credentials and injection variables', () => {
  assert.deepEqual(nativeEnvironment({ PATH: '/bin', HOME: '/owner', BUDDI_VAULT_KEY: 'secret', DATABASE_URL: 'secret', OPENAI_API_KEY: 'secret', PGOPTIONS: 'unsafe', NODE_OPTIONS: 'unsafe', DYLD_INSERT_LIBRARIES: 'unsafe' }), { PATH: '/bin', HOME: '/owner' });
});

test('private files reject symlinks, non-files and permissive modes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-private-test-'));
  const file = path.join(dir, 'vault-key');
  assert.equal(await readPrivateFile(file), undefined);
  await writeFile(file, 'fixture', { mode: 0o600 });
  assert.equal(await readPrivateFile(file), 'fixture');
  const link = path.join(dir, '.env'); await symlink(file, link);
  await assert.rejects(readPrivateFile(link), /symbolic links/);
  await assert.rejects(readPrivateFile(dir), /regular file/);
  await chmod(file, 0o644);
  await assert.rejects(readPrivateFile(file), /owner-only/);
});

test('adopted database is watched without a child exit event', async () => {
  let probes = 0;
  const monitor = watchDatabase(async () => { probes++; throw new Error('down'); }, { interval: 1, failures: 2 });
  await monitor.exited;
  assert.equal(monitor.alive, false); assert.equal(probes, 2);
  monitor.stop();
});

test('database probe failures must be consecutive and probes are serialized', async () => {
  let probes = 0, inFlight = 0;
  const monitor = watchDatabase(async () => {
    assert.equal(++inFlight, 1);
    await new Promise(resolve => setTimeout(resolve, 2)); inFlight--;
    probes++;
    if (probes !== 2) throw new Error('down');
  }, { interval: 1, failures: 2 });
  await monitor.exited; monitor.stop();
  assert.equal(probes, 4);
});

test('stopping a monitor cancels future probes', async () => {
  let probes = 0;
  const monitor = watchDatabase(async () => { probes++; }, { interval: 1 });
  monitor.stop(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(probes, 0);
});

test('gateway restart backoff is exponential and bounded', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 1000].map(restartDelay), [2000, 4000, 8000, 16000, 30000, 30000]);
});

test('LaunchAgent replacement unloads old arguments before bootstrapping', async () => {
  const calls = [];
  let prints = 0;
  await reloadLaunchAgent(async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'print' && ++prints === 2) throw Object.assign(new Error(), { code: 113, stderr: 'Could not find service' });
  }, 'gui/501', 'fixture', '/fixture.plist');
  assert.deepEqual(calls, [['launchctl', 'bootout', 'gui/501/fixture'], ['launchctl', 'print', 'gui/501/fixture'], ['launchctl', 'print', 'gui/501/fixture'], ['launchctl', 'bootstrap', 'gui/501', '/fixture.plist']]);
});

test('LaunchAgent reload tolerates only the absent-job error', async () => {
  let calls = 0;
  await reloadLaunchAgent(async () => { if (++calls === 1) throw Object.assign(new Error(), { code: 3, stderr: 'Boot-out failed: 3: No such process' }); }, 'gui/501', 'fixture', '/fixture');
  assert.equal(calls, 2);
  await assert.rejects(reloadLaunchAgent(async () => { throw Object.assign(new Error('denied'), { code: 5, stderr: 'Input/output error' }); }, 'gui/501', 'fixture', '/fixture'), /denied/);
});

test('readiness rejects arbitrary 401s and proofs from another install', async () => {
  assert.equal(await dashboardReady(4317, 'fixture', async () => new Response('', { status: 401 })), false);
  assert.equal(await dashboardReady(4317, 'fixture', async () => Response.json({ proof: 'wrong' })), false);
  assert.equal(await dashboardReady(4317, 'fixture', async url => {
    const challenge = new URL(url).searchParams.get('challenge');
    return Response.json({ proof: createHmac('sha256', 'fixture').update(`buddi-ready-v1:${challenge}`).digest('hex') });
  }), true);
});
