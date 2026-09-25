import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { BackupControl, BackupJob } from './backup.js';
import type { ReadyContext } from './environment.js';
import {
  NOT_GLOBAL,
  compareVersions,
  createInstaller,
  createUpgradeService,
  finishUpgrade,
  handOver,
  installArgs,
  installTarget,
  isNewer,
  isVersion,
  readUpgradeState,
  recoverySentence,
  restartPlan,
  upgradeDoctorLines,
  upgradeTarget,
  versionView,
  writeUpgradeState,
  type UpgradeHistoryEntry,
  type UpgradeState,
} from './upgrade.js';

/** An installation on disk, minus everything an upgrade does not touch. */
async function installation(version = '0.1.0'): Promise<ReadyContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'buddi-root-'));
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-data-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version }));
  return { root, data, env: {}, state: { version: 1, database: 'managed', webPort: 4317, dbPort: 5555, phase: 'ready' } };
}

/** A backup that has already happened. The upgrade only ever waits for one. */
function backupControl(overrides: Partial<BackupControl> = {}): BackupControl {
  const done: BackupJob = {
    id: 'b1', kind: 'backup', phase: 'done', phases: ['starting', 'done'],
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    report: { archive: 'buddi-backup-20260101-000000.tar.gz' },
  };
  return {
    create: () => done, busy: () => false, job: () => undefined,
    schedule: async () => ({ encryptLocal: true }), hasVault: () => true,
    ...overrides,
  } as unknown as BackupControl;
}

/** The registry, as a transport. No test in this file touches the network. */
function registry(version: string, extra: Record<string, unknown> = {}): (url: string) => Promise<{ status: number; json: () => Promise<unknown> }> {
  return async (url: string) => {
    expect(url).toBe('https://registry.example/%40withbuddi%2Fbuddi/latest');
    return { status: 200, json: async () => ({ name: '@withbuddi/buddi', version, ...extra }) };
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
  test('are compared by semver, prereleases and all', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    // The precedence the old field-by-field compare got wrong, both ways.
    expect(compareVersions('2.0.0-rc.10', '2.0.0-rc.2')).toBe(1);
    expect(compareVersions('2.0.0-alpha', '2.0.0-alpha.1')).toBe(-1);
    // Not a version is not an ordering: nobody may guess from it.
    expect(compareVersions('latest', '1.0.0')).toBeUndefined();
    expect(isNewer('0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    // Nothing is newer than a version we could not read.
    expect(isNewer('9.9.9', 'unknown')).toBe(false);
    expect(isNewer(undefined, '0.1.0')).toBe(false);
  });

  test('are only ever one canonical release, never a range, a tag or a URL', () => {
    for (const good of ['0.1.0', '1.2.3', '10.0.0-rc.1', '1.0.0-beta-2']) expect(isVersion(good)).toBe(true);
    for (const bad of ['latest', '^1.2.0', '1.2', 'v1.2.3', '1.2.3 ', 'npm:other@1.0.0', 'https://x.example/a.tgz', '1.2.3; rm -rf /', '']) {
      expect(isVersion(bad)).toBe(false);
    }
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

  test('keeps the release notes the registry document carries', async () => {
    const ctx = await installation();
    const { upgrade } = service(ctx, { http: registry('0.1.1', { buddi: { notes: '### Fixed\n\n- A thing.\n' } }) as never });
    const view = await upgrade.check();
    expect(view.latestNotes).toBe('### Fixed\n\n- A thing.');
    // Written down, so the gateway and the next supervisor read the same.
    expect((await readUpgradeState(ctx.data, '0.1.0')).check.latestNotes).toBe('### Fixed\n\n- A thing.');
  });

  test('a release without notes, or with notes that are not text, has none, and clears the last ones', async () => {
    const ctx = await installation();
    await writeUpgradeState(ctx.data, { check: { enabled: true, latest: '0.1.1', latestNotes: 'Old notes.' }, current: '0.1.0', history: [] });
    const { upgrade } = service(ctx, { http: registry('0.1.2') as never });
    const view = await upgrade.check();
    expect(view.latest).toBe('0.1.2');
    expect(view.latestNotes).toBeUndefined();
    const odd = service(ctx, { http: registry('0.1.3', { buddi: { notes: 42 } }) as never });
    expect((await odd.upgrade.check()).latestNotes).toBeUndefined();
    const long = service(ctx, { http: registry('0.1.4', { buddi: { notes: 'x'.repeat(20_000) } }) as never });
    expect((await long.upgrade.check()).latestNotes).toHaveLength(8 * 1024);
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
    // The scoped name the package is published under sits one level deeper.
    expect(installTarget('/opt/homebrew/lib/node_modules/@withbuddi/buddi')).toEqual({ prefix: '/opt/homebrew', global: true });
    expect(installTarget('/tmp/smoke/node_modules/@withbuddi/buddi').prefix).toBe('/tmp/smoke');
    expect(installArgs('buddi@0.1.1', { registry: 'https://r.example', root: '/opt/homebrew/lib/node_modules/buddi' }))
      .toEqual(['install', '-g', '--prefix', '/opt/homebrew', 'buddi@0.1.1', '--registry', 'https://r.example', '--ignore-scripts', '--no-audit', '--no-fund']);
    // What the release smoke makes: a plain tree, upgraded in place.
    expect(installTarget('/tmp/smoke/node_modules/buddi').prefix).toBe('/tmp/smoke');
    expect(installArgs('x.tgz', { registry: 'r', root: '/tmp/smoke/node_modules/buddi' })).not.toContain('-g');
  });

  test('never runs an install script, here as everywhere else', () => {
    const args = installArgs('buddi@0.1.1', { registry: 'r', root: '/opt/homebrew/lib/node_modules/buddi' });
    expect(args).toContain('--ignore-scripts');
    expect(args.some(arg => arg.includes('ignore-scripts=false'))).toBe(false);
  });

  test('verifies the tarball into the cache before the tree is touched', async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (_binary: string, argv: string[]) => { calls.push(argv); });
    const where = { registry: 'https://r.example', root: '/opt/homebrew/lib/node_modules/buddi' };
    await createInstaller({ binary: 'npm', runner })('buddi@0.1.1', where);
    expect(calls[0]).toEqual(['cache', 'add', 'buddi@0.1.1', '--registry', 'https://r.example']);
    expect(calls[1]?.[0]).toBe('install');

    /*
     * The one that matters: bytes that do not match the registry's
     * `dist.integrity` fail here, where nothing in the install root has been
     * replaced yet. `npm install` fails at the same hash *after* it has begun
     * unpacking, and leaves an installation that cannot be started again.
     */
    calls.length = 0;
    const corrupt = createInstaller({
      binary: 'npm',
      runner: async (_binary, argv) => {
        calls.push(argv);
        if (argv[0] === 'cache') throw Object.assign(new Error('exit 1'), { stderr: 'npm error code EINTEGRITY' });
      },
    });
    await expect(corrupt('buddi@0.1.1', where)).rejects.toThrow(/npm cache add buddi@0\.1\.1 failed: .*EINTEGRITY/s);
    // Nothing was installed: the tree is untouched.
    expect(calls.map(argv => argv[0])).toEqual(['cache']);

    // A tarball on disk has no registry to verify it against, so there is
    // nothing to fetch first: `BUDDI_UPGRADE_SOURCE` installs as it always did.
    calls.length = 0;
    await createInstaller({ binary: 'npm', runner })('/tmp/buddi-0.1.1.tgz', where);
    expect(calls.map(argv => argv[0])).toEqual(['install']);
  });

  test('refuses an installation that lives inside somebody else\'s project', () => {
    // A prefix npm made for an installation of its own: dependencies, no name.
    expect(upgradeTarget('/tmp/smoke/node_modules/buddi', { platform: 'darwin', manifest: () => ({ dependencies: { buddi: 'file:x.tgz' } }) as { name?: unknown } }))
      .toEqual({ prefix: '/tmp/smoke', global: false });
    // Somebody's project, which an upgrade would rewrite behind their back.
    expect(upgradeTarget('/home/me/app/node_modules/buddi', { platform: 'darwin', manifest: () => ({ name: 'app' }) }))
      .toEqual({ error: NOT_GLOBAL });
    // The global tree is upgraded whatever sits beside it.
    expect(upgradeTarget('/opt/homebrew/lib/node_modules/buddi', { platform: 'darwin', manifest: () => ({ name: 'anything' }) }))
      .toEqual({ prefix: '/opt/homebrew', global: true });
    // On Windows the two layouts look the same, so neither is guessed at.
    expect(upgradeTarget('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\buddi', { platform: 'win32', manifest: () => undefined }))
      .toEqual({ error: NOT_GLOBAL });
  });
});

describe('the hand-over', () => {
  test('is an exit under launchd, and a spawn everywhere else', () => {
    const label = 'com.buddi.install.abc123';
    expect(restartPlan({ platform: 'darwin', label, xpcServiceName: label }).mode).toBe('launchd');
    // A detached supervisor is reparented to pid 1 too, and used to read as
    // launchd's on a machine that merely has the agent installed.
    expect(restartPlan({ platform: 'darwin', label, xpcServiceName: undefined }).mode).toBe('spawn');
    expect(restartPlan({ platform: 'darwin', label, xpcServiceName: '0' }).mode).toBe('spawn');
    expect(restartPlan({ platform: 'darwin', label, xpcServiceName: 'com.buddi.install.other' }).mode).toBe('spawn');
    expect(restartPlan({ platform: 'linux', label, xpcServiceName: label }).mode).toBe('spawn');
    // On Linux the unit names itself in BUDDI_SERVICE_UNIT; anything else spawns.
    expect(restartPlan({ platform: 'linux', label, serviceUnit: label }).mode).toBe('systemd');
    expect(restartPlan({ platform: 'linux', label, serviceUnit: 'com.buddi.install.other' }).mode).toBe('spawn');
    expect(restartPlan({ platform: 'darwin', label, serviceUnit: label }).mode).toBe('spawn');
  });

  test('waits for the successor to answer, and tries once more before giving up', async () => {
    const ctx = await installation();
    await mkdir(path.join(ctx.data, 'logs'), { recursive: true });
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: () => {} })) as never;
    const plan = { mode: 'spawn', reason: 'test' } as const;

    // Nobody ever answers: two attempts, then the truth.
    const lost = await handOver({ ctx, launcher: '/x/launcher.js', env: {}, plan, spawnProcess, log: () => {}, waitMs: 5, ready: async () => false });
    expect(lost).toMatchObject({ ok: false, attempts: 2 });
    expect(spawnProcess).toHaveBeenCalledTimes(2);

    // The socket answers with the new version: one attempt, and done.
    const answers = vi.fn(async () => true);
    const back = await handOver({ ctx, launcher: '/x/launcher.js', env: {}, plan, spawnProcess, log: () => {}, waitMs: 5, ready: answers });
    expect(back).toMatchObject({ ok: true, attempts: 1 });
    expect(spawnProcess).toHaveBeenCalledTimes(3);
  });

  test('under launchd it starts nothing at all', async () => {
    const ctx = await installation();
    const spawnProcess = vi.fn() as never;
    const result = await handOver({ ctx, launcher: '/x/launcher.js', env: {}, plan: { mode: 'launchd', reason: 'test' }, spawnProcess, log: () => {}, ready: async () => false });
    expect(result).toMatchObject({ ok: true, attempts: 0 });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe('an upgrade', () => {
  test('backs up, stops the gateway, installs and hands over', async () => {
    const ctx = await installation();
    const { upgrade, install, stopGateway, restart, startGateway } = service(ctx);
    // The fake installer leaves 0.1.0 on disk, so 0.1.0 is what is asked for:
    // the version installed and the version requested have to match.
    const started = upgrade.start('0.1.0');
    expect('status' in started).toBe(false);
    const job = await settled(upgrade, (started as BackupJob).id);
    expect(job.phases).toEqual(['starting', 'backup', 'stopping', 'installing', 'restarting']);
    expect(stopGateway).toHaveBeenCalled();
    expect(startGateway).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith('@withbuddi/buddi@0.1.0', { registry: 'https://registry.example', root: ctx.root, target: { prefix: path.dirname(ctx.root), global: false } });
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
    expect(install).toHaveBeenCalledWith('/tmp/buddi-0.1.1.tgz', expect.objectContaining({ registry: 'https://registry.example', root: ctx.root }));
  });

  test('refuses a version that is not one, and never asks npm', async () => {
    const ctx = await installation();
    const { upgrade, install } = service(ctx);
    for (const bad of ['latest', '^0.1.1', 'npm:evil@1.0.0', '0.1.1 && curl x']) {
      expect(upgrade.start(bad)).toEqual({ status: 400, error: `"${bad}" is not a version this can install.` });
    }
    expect(install).not.toHaveBeenCalled();
  });

  test('resolves "the newest" to a version through the check before npm sees it', async () => {
    const ctx = await installation();
    const { upgrade, install } = service(ctx);
    // Nothing was checked yet, so starting an upgrade with no version asks.
    await settled(upgrade, (upgrade.start() as BackupJob).id);
    expect(install).toHaveBeenCalledWith('@withbuddi/buddi@0.1.1', expect.anything());
    // And what it resolved to is what the history names, never `latest`.
    expect((await upgrade.view()).history.at(-1)).toMatchObject({ to: '0.1.1', step: 'installing' });
  });

  test('a registry that names nothing installable stops the upgrade before the backup', async () => {
    const ctx = await installation();
    const { upgrade, install, stopGateway } = service(ctx, { http: registry('latest') as never });
    const job = await settled(upgrade, (upgrade.start() as BackupJob).id);
    expect(job.phase).toBe('failed');
    expect(install).not.toHaveBeenCalled();
    expect(stopGateway).not.toHaveBeenCalled();
    expect((await upgrade.view()).history.at(-1)).toMatchObject({ outcome: 'failed', step: 'checking' });
    // The word never became a version on disk either.
    expect((await upgrade.view()).latest).toBeUndefined();
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
    // The version that was asked for, never the word `latest`.
    expect(entry).toMatchObject({ outcome: 'failed', step: 'installing', from: '0.1.0', to: '0.1.1', backup: 'buddi-backup-20260101-000000.tar.gz' });
    // Nothing was handed over, so the phase never moved.
    expect(ctx.state.phase).toBe('ready');
  });

  test('an install that put something else there is a failed upgrade, not a migration', async () => {
    const ctx = await installation();
    // npm "succeeded" and the root still says 0.1.0: not what was asked for.
    const { upgrade, restart, startGateway } = service(ctx);
    const job = await settled(upgrade, (upgrade.start('0.1.1') as BackupJob).id);
    expect(job.phase).toBe('failed');
    expect(job.error).toMatch(/0\.1\.1 was asked for and 0\.1\.0 was installed/);
    expect(restart).not.toHaveBeenCalled();
    expect(startGateway).toHaveBeenCalled();
    expect((await upgrade.view()).history.at(-1)).toMatchObject({ outcome: 'failed', step: 'installing' });
    expect(ctx.state.phase).toBe('ready');
  });

  test('nothing starts the old gateway once the new code is on disk', async () => {
    const ctx = await installation();
    const { upgrade, startGateway } = service(ctx, {
      // The hand-over itself throws: the code under this process is already new.
      restart: () => { throw new Error('exec failed'); },
    });
    const job = await settled(upgrade, (upgrade.start('0.1.0') as BackupJob).id);
    expect(job.phase).toBe('failed');
    expect(startGateway).not.toHaveBeenCalled();
    expect(ctx.state.phase).toBe('upgrading');
    expect(ctx.state.upgrade).toMatchObject({ from: '0.1.0', to: '0.1.0' });
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

  test('a backup that never finishes is given twenty minutes, and then the upgrade fails', async () => {
    const ctx = await installation();
    const hanging: BackupJob = { id: 'b3', kind: 'backup', phase: 'dump', phases: ['starting', 'dump'], startedAt: 'now' };
    const { upgrade, install, stopGateway } = service(ctx, { backup: backupControl({ create: () => hanging }), backupWaitMs: 20 });
    const job = await settled(upgrade, (upgrade.start('0.1.1') as BackupJob).id);
    expect(job.phase).toBe('failed');
    expect(job.error).toMatch(/twenty minutes/);
    expect(install).not.toHaveBeenCalled();
    // The gateway was never stopped, so buddi is still serving.
    expect(stopGateway).not.toHaveBeenCalled();
  });

  test('the backup before an upgrade is encrypted exactly as the schedule says', async () => {
    const ctx = await installation();
    const create = vi.fn(() => ({ id: 'b4', kind: 'backup', phase: 'done', phases: ['done'], startedAt: 'now', finishedAt: 'now', report: { archive: 'a.tar.gz' } } as BackupJob));
    const plain = service(ctx, { backup: backupControl({ create, schedule: async () => ({ encryptLocal: false }) as never }) });
    await settled(plain.upgrade, (plain.upgrade.start('0.1.1') as BackupJob).id);
    expect(create).toHaveBeenCalledWith(false);

    const other = await installation();
    const encrypted = service(other, { backup: backupControl({ create, schedule: async () => ({ encryptLocal: true }) as never }) });
    await settled(encrypted.upgrade, (encrypted.upgrade.start('0.1.1') as BackupJob).id);
    expect(create).toHaveBeenLastCalledWith(true);
  });

  test('encryption with nowhere to keep the key is said before the gateway stops', async () => {
    const ctx = await installation();
    const { upgrade, stopGateway, install } = service(ctx, {
      backup: backupControl({ hasVault: () => false, schedule: async () => ({ encryptLocal: true }) as never }),
    });
    const job = await settled(upgrade, (upgrade.start('0.1.1') as BackupJob).id);
    expect(job.phase).toBe('failed');
    expect(job.error).toMatch(/no vault/);
    expect(stopGateway).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();

    // With encryption off, the same installation upgrades.
    const off = service(await installation(), { backup: backupControl({ hasVault: () => false, schedule: async () => ({ encryptLocal: false }) as never }) });
    const done = await settled(off.upgrade, (off.upgrade.start('0.1.0') as BackupJob).id);
    expect(done.phase).toBe('restarting');
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

  test('an installation waiting on a failed migration is not offered another upgrade', async () => {
    const ctx = await installation();
    ctx.state.phase = 'upgrade-failed';
    const http = vi.fn(registry('0.1.1') as never);
    const { upgrade } = service(ctx, { http: http as never });
    await upgrade.tick();
    expect(http).not.toHaveBeenCalled();
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

  test('a migration that worked under the wrong build is never done', async () => {
    /*
     * The recovery an owner is told to run: the previous version is
     * reinstalled and the supervisor that comes up finds the same marker. The
     * migration that broke is not in that tree any more, so it migrates
     * happily — and calling that `done: 0.1.0 to 0.1.1` would put a version
     * that is not installed into the history as a success.
     */
    const ctx = await installation('0.1.0');
    ctx.state.phase = 'upgrade-failed';
    const pending = { from: '0.1.0', to: '0.1.1', backup: 'buddi-backup-20260101-000000.tar.gz', startedAt: 'then' };
    ctx.state.upgrade = pending;
    const entry = await finishUpgrade(ctx, pending, { ok: true });
    expect(entry).toMatchObject({
      outcome: 'failed',
      step: 'finishing',
      from: '0.1.0',
      to: '0.1.1',
      error: 'buddi 0.1.0 finished an upgrade that was meant to reach 0.1.1',
    });
    // The upgrade is over either way, and the installation opens: the code
    // that is on disk is code that runs.
    expect(ctx.state.upgrade).toBeUndefined();
    expect(ctx.state.phase).toBe('ready');
    const state = await readUpgradeState(ctx.data, '0.1.0');
    expect(state.current).toBe('0.1.0');
    expect(state.history.at(-1)?.outcome).toBe('failed');
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
      'Reinstall with `npm install -g @withbuddi/buddi@0.1.0` and run `buddi backup restore buddi-backup-20260101-000000.tar.gz`.',
    );
    // New code that cannot start at all is the same failure, one step earlier.
    expect(recoverySentence({ ...entry, step: 'starting', error: 'Postgres binaries missing' }))
      .toMatch(/^Upgrade to 0\.1\.1 failed while starting: Postgres binaries missing\./);
    const lines = upgradeDoctorLines(versionView(await readUpgradeState(ctx.data, '0.1.1')), 'upgrade-failed');
    expect(lines[0]).toBe('Version: 0.1.1');
    expect(lines.at(-1)).toMatch(/^Upgrade to 0\.1\.1 failed while migrating/);
  });
});
