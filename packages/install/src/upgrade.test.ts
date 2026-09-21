import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { BackupControl, BackupJob } from './backup.js';
import type { ReadyContext } from './environment.js';
import {
  compareVersions,
  createUpgradeService,
  finishUpgrade,
  installArgs,
  installTarget,
  isNewer,
  readUpgradeState,
  recoverySentence,
  restartPlan,
  upgradeDoctorLines,
  versionView,
  writeUpgradeState,
  type UpgradeHistoryEntry,
  type UpgradeState,
} from './upgrade.js';

/** An installation on disk, minus everything an upgrade does not touch. */
async function installation(version = '0.1.0'): Promise<ReadyContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'buddi-root-'));
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-data-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'buddi', version }));
  return { root, data, env: {}, state: { version: 1, database: 'managed', webPort: 4317, dbPort: 5555, phase: 'ready' } };
}

/** A backup that has already happened. The upgrade only ever waits for one. */
function backupControl(overrides: Partial<BackupControl> = {}): BackupControl {
  const done: BackupJob = {
    id: 'b1', kind: 'backup', phase: 'done', phases: ['starting', 'done'],
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    report: { archive: 'buddi-backup-20260101-000000.tar.gz' },
  };
  return { create: () => done, busy: () => false, job: () => undefined, ...overrides } as BackupControl;
}

/** The registry, as a transport. No test in this file touches the network. */
function registry(version: string): (url: string) => Promise<{ status: number; json: () => Promise<unknown> }> {
  return async (url: string) => {
    expect(url).toBe('https://registry.example/buddi/latest');
    return { status: 200, json: async () => ({ name: 'buddi', version }) };
  };
}

function service(ctx: ReadyContext, opts: Partial<Parameters<typeof createUpgradeService>[0]> = {}) {
  const install = vi.fn(async () => {});
  const stopGateway = vi.fn(async () => {});
  const startGateway = vi.fn(() => {});
  const restart = vi.fn(() => {});
  ctx.env.BUDDI_NPM_REGISTRY = ctx.env.BUDDI_NPM_REGISTRY ?? 'https://registry.example';
  const upgrade = createUpgradeService({
    ctx, current: '0.1.0', backup: backupControl(), stopGateway, startGateway, restart,
    install, http: registry('0.1.1') as never, log: () => {}, ...opts,
  });
  return { upgrade, install, stopGateway, startGateway, restart };
}

/** The job is asynchronous by construction; this is the only way to read it. */
async function settled(upgrade: ReturnType<typeof service>['upgrade'], id: string): Promise<BackupJob> {
  for (let i = 0; i < 200; i++) {
    const job = upgrade.job(id);
    if (job?.finishedAt !== undefined || job?.phase === 'restarting') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('the upgrade job never settled');
}

describe('versions', () => {
  test('are compared field by field, with a prerelease before its release', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(isNewer('0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    // Nothing is newer than a version we could not read.
    expect(isNewer('9.9.9', 'unknown')).toBe(false);
    expect(isNewer(undefined, '0.1.0')).toBe(false);
  });
});

describe('the upgrade state file', () => {
  test('round-trips, keeps the last ten entries and survives a hand edit', async () => {
    const ctx = await installation();
    const history: UpgradeHistoryEntry[] = Array.from({ length: 14 }, (_, i) => ({
      from: `0.0.${i}`, to: `0.0.${i + 1}`, startedAt: new Date().toISOString(), outcome: 'done',
    }));
    await writeUpgradeState(ctx.data, { check: { enabled: false, latest: '0.2.0' }, current: '0.1.0', history });
    const read = await readUpgradeState(ctx.data, '0.1.0');
    expect(read.history).toHaveLength(10);
    expect(read.history[0]!.from).toBe('0.0.4');
    expect(read.check).toEqual({ enabled: false, latest: '0.2.0' });

    await writeFile(path.join(ctx.data, 'upgrade.json'), '{ not json');
    expect((await readUpgradeState(ctx.data, '0.1.0')).check.enabled).toBe(true);
  });

  test('the view says what the dashboard renders', () => {
    const state: UpgradeState = { check: { enabled: true, latest: '0.1.1', lastAt: 'then' }, current: '0.1.0', history: [] };
    expect(versionView(state)).toEqual({ current: '0.1.0', latest: '0.1.1', checkedAt: 'then', checkEnabled: true, updateAvailable: true, history: [] });
  });
});

describe('the check', () => {
  test('records the version the registry named', async () => {
    const ctx = await installation();
    const { upgrade } = service(ctx);
    const view = await upgrade.check();
    expect(view.latest).toBe('0.1.1');
    expect(view.updateAvailable).toBe(true);
    expect(view.checkedAt).toBeDefined();
  });

  test('a registry that does not answer sets the error and changes nothing else', async () => {
    const ctx = await installation();
    const { upgrade } = service(ctx, { http: (async () => ({ status: 503, json: async () => ({}) })) as never });
    const view = await upgrade.check();
    expect(view.error).toMatch(/503/);
    expect(view.latest).toBeUndefined();
    expect(view.updateAvailable).toBe(false);
  });

  test('the daily tick asks once a day, and never when the switch is off', async () => {
    const ctx = await installation();
    const http = vi.fn(registry('0.1.1') as never);
    const { upgrade } = service(ctx, { http: http as never, checkIntervalMs: 24 * 60 * 60 * 1000 });
    await upgrade.tick();
    expect(http).toHaveBeenCalledTimes(1);
    const first = (await upgrade.view()).checkedAt;

    // Within the day: nothing.
    await upgrade.tick();
    expect(http).toHaveBeenCalledTimes(1);
    expect((await upgrade.view()).checkedAt).toBe(first);

    // A day later: once more.
    await upgrade.tick(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(http).toHaveBeenCalledTimes(2);

    // Switched off: not even then.
    await upgrade.setCheckEnabled(false);
    await upgrade.tick(new Date(Date.now() + 90 * 60 * 60 * 1000));
    expect(http).toHaveBeenCalledTimes(2);
    expect((await upgrade.view()).checkEnabled).toBe(false);

    // A check the owner asks for still runs: the switch is about the tick.
    await upgrade.check();
    expect(http).toHaveBeenCalledTimes(3);
  });
});

describe('where npm is told to install', () => {
  test('is read off the install root, never off npm\'s own prefix', () => {
    expect(installTarget('/opt/homebrew/lib/node_modules/buddi')).toEqual({ prefix: '/opt/homebrew', global: true });
    expect(installArgs('buddi@0.1.1', { registry: 'https://r.example', root: '/opt/homebrew/lib/node_modules/buddi' }))
      .toEqual(['install', '-g', '--prefix', '/opt/homebrew', 'buddi@0.1.1', '--registry', 'https://r.example', '--ignore-scripts=false', '--no-audit', '--no-fund']);
    // What the release smoke makes: a plain tree, upgraded in place.
    expect(installTarget('/tmp/smoke/node_modules/buddi').prefix).toBe('/tmp/smoke');
    expect(installArgs('x.tgz', { registry: 'r', root: '/tmp/smoke/node_modules/buddi' })).not.toContain('-g');
  });
});

describe('the hand-over', () => {
  test('is an exit under launchd, and a spawn everywhere else', () => {
    const plist = path.join(process.cwd(), 'package.json'); // any file that exists
    expect(restartPlan({ platform: 'darwin', ppid: 1, plist }).mode).toBe('launchd');
    // Detached, but not launchd's: no plist for this installation.
    expect(restartPlan({ platform: 'darwin', ppid: 1, plist: '/nowhere/com.buddi.install.plist' }).mode).toBe('spawn');
    // A foreground supervisor, which is what the smoke runs.
    expect(restartPlan({ platform: 'darwin', ppid: 4321, plist }).mode).toBe('spawn');
    expect(restartPlan({ platform: 'linux', ppid: 1, plist }).mode).toBe('spawn');
  });
});

describe('an upgrade', () => {
  test('backs up, stops the gateway, installs and hands over', async () => {
    const ctx = await installation();
    const { upgrade, install, stopGateway, restart, startGateway } = service(ctx);
    const started = upgrade.start('0.1.1');
    expect('status' in started).toBe(false);
    const job = await settled(upgrade, (started as BackupJob).id);
    expect(job.phases).toEqual(['starting', 'backup', 'stopping', 'installing', 'restarting']);
    expect(stopGateway).toHaveBeenCalled();
    expect(startGateway).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith('buddi@0.1.1', { registry: 'https://registry.example', root: ctx.root });
    expect(restart).toHaveBeenCalled();
    // The point of no return, on disk before it is taken.
    const state = JSON.parse(await readFile(path.join(ctx.data, 'installation.json'), 'utf8')) as typeof ctx.state;
    expect(state.phase).toBe('upgrading');
    expect(state.upgrade).toMatchObject({ from: '0.1.0', to: '0.1.0', backup: 'buddi-backup-20260101-000000.tar.gz' });
    // Nothing is in the history yet: the new supervisor writes the outcome.
    expect((await upgrade.view()).history).toEqual([]);
  });

  test('installs a tarball when BUDDI_UPGRADE_SOURCE names one', async () => {
    const ctx = await installation();
    ctx.env.BUDDI_UPGRADE_SOURCE = '/tmp/buddi-0.1.1.tgz';
    const { upgrade, install } = service(ctx);
    await settled(upgrade, (upgrade.start() as BackupJob).id);
    expect(install).toHaveBeenCalledWith('/tmp/buddi-0.1.1.tgz', { registry: 'https://registry.example', root: ctx.root });
  });

  test('an install that fails leaves buddi running, and says where it stopped', async () => {
    const ctx = await installation();
    const { upgrade, startGateway } = service(ctx, {
      install: async () => { throw new Error('npm install buddi@0.1.1 failed: 404 Not Found'); },
    });
    const job = await settled(upgrade, (upgrade.start('0.1.1') as BackupJob).id);
    expect(job.phase).toBe('failed');
    expect(job.error).toMatch(/404/);
    expect(startGateway).toHaveBeenCalled();
    const entry = (await upgrade.view()).history.at(-1)!;
    expect(entry).toMatchObject({ outcome: 'failed', step: 'installing', from: '0.1.0', to: '0.1.1', backup: 'buddi-backup-20260101-000000.tar.gz' });
    // Nothing was handed over, so the phase never moved.
    expect(ctx.state.phase).toBe('ready');
  });

  test('a backup that fails stops the upgrade before anything is touched', async () => {
    const ctx = await installation();
    const failed: BackupJob = { id: 'b2', kind: 'backup', phase: 'failed', phases: ['starting', 'failed'], startedAt: 'now', finishedAt: 'now', error: 'no disk space' };
    const { upgrade, install, stopGateway } = service(ctx, { backup: backupControl({ create: () => failed }) });
    const job = await settled(upgrade, (upgrade.start() as BackupJob).id);
    expect(job.phase).toBe('failed');
    expect(install).not.toHaveBeenCalled();
    expect(stopGateway).not.toHaveBeenCalled();
    expect((await upgrade.view()).history.at(-1)).toMatchObject({ outcome: 'failed', step: 'backup', error: 'no disk space' });
  });

  test('refuses a second upgrade, and one on top of a restore', async () => {
    const ctx = await installation();
    const { upgrade } = service(ctx, { install: async () => { await new Promise(resolve => setTimeout(resolve, 50)); } });
    upgrade.start();
    expect(upgrade.start()).toEqual({ status: 409, error: 'An upgrade is already running.' });
    expect(upgrade.busy()).toBe(true);

    const restoring = service(await installation(), { backup: backupControl({ busy: () => true }) });
    expect(restoring.upgrade.start()).toEqual({ status: 409, error: 'A restore is running.' });
  });
});

describe('finishing in the new code', () => {
  test('a migration that worked writes done and clears the phase', async () => {
    const ctx = await installation('0.1.1');
    ctx.state.phase = 'upgrading';
    const pending = { from: '0.1.0', to: '0.1.1', backup: 'buddi-backup-20260101-000000.tar.gz', startedAt: 'then' };
    ctx.state.upgrade = pending;
    const entry = await finishUpgrade(ctx, pending, { ok: true });
    expect(entry.outcome).toBe('done');
    expect(ctx.state.phase).toBe('ready');
    expect(ctx.state.upgrade).toBeUndefined();
    const state = await readUpgradeState(ctx.data, '0.1.1');
    expect(state.history).toHaveLength(1);
  });

  test('a migration that failed leaves the phase, the archive and the way back', async () => {
    const ctx = await installation('0.1.1');
    ctx.state.phase = 'upgrading';
    const pending = { from: '0.1.0', to: '0.1.1', backup: 'buddi-backup-20260101-000000.tar.gz', startedAt: 'then' };
    ctx.state.upgrade = pending;
    const entry = await finishUpgrade(ctx, pending, { ok: false, error: 'relation "core.jobs" already exists' });
    expect(entry).toMatchObject({ outcome: 'failed', step: 'migrating' });
    expect(ctx.state.phase).toBe('upgrade-failed');
    // The phase is kept, so the next start can still say what happened.
    expect(ctx.state.upgrade).toEqual(pending);
    expect(recoverySentence(entry)).toBe(
      'Upgrade to 0.1.1 failed while migrating: relation "core.jobs" already exists. ' +
      'The backup taken first is buddi-backup-20260101-000000.tar.gz. ' +
      'Reinstall with `npm install -g buddi@0.1.0` and run `buddi backup restore buddi-backup-20260101-000000.tar.gz`.',
    );
    // New code that cannot start at all is the same failure, one step earlier.
    expect(recoverySentence({ ...entry, step: 'starting', error: 'Postgres binaries missing' }))
      .toMatch(/^Upgrade to 0\.1\.1 failed while starting: Postgres binaries missing\./);
    const lines = upgradeDoctorLines(versionView(await readUpgradeState(ctx.data, '0.1.1')), 'upgrade-failed');
    expect(lines[0]).toBe('Version: 0.1.1');
    expect(lines.at(-1)).toMatch(/^Upgrade to 0\.1\.1 failed while migrating/);
  });
});
