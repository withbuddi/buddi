import { mkdir, mkdtemp, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { BackupControl, BackupJob } from './backup.js';
import type { ReadyContext } from './environment.js';
import {
  APP_BUNDLE,
  APP_LAYOUT_VAR,
  appLayout,
  insideAppBundle,
  provenanceVerdict,
  pruneReleases,
  releaseLinks,
  releaseRoot,
  stageRelease,
  switchCurrent,
} from './app-layout.js';
import { createUpgradeService, recoverySentence, restartPlan, upgradeDoctorLines, upgradeTarget, versionView } from './upgrade.js';
import type { NpmRunner } from './upgrade.js';

const REGISTRY = 'https://registry.example';
const INTEGRITY = (v: string): string => `sha512-${Buffer.from(`tarball ${v}`).toString('base64')}`;

/** The SLSA statement npm verified, as `audit signatures --include-attestations` hands it back. */
function slsa(repository: string): string {
  return Buffer.from(JSON.stringify({ predicate: { buildDefinition: { externalParameters: { workflow: { repository } } } } })).toString('base64');
}

function auditReport(version: string, opts: { repository?: string; invalid?: boolean; noProvenance?: boolean } = {}): string {
  if (opts.invalid) return JSON.stringify({ invalid: [{ name: '@withbuddi/buddi', version, code: 'EATTESTATIONVERIFY', message: 'signature does not match' }], missing: [] });
  return JSON.stringify({
    invalid: [], missing: [],
    verified: [{
      name: '@withbuddi/buddi', version,
      ...(opts.noProvenance ? {} : { attestations: { url: 'x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }),
      attestationBundles: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: slsa(opts.repository ?? 'https://github.com/withbuddi/buddi') } } }],
    }],
  });
}

/** The registry, as a transport: `/latest`, one version's packument, and the tarball HEAD. */
function registry(latest: string, opts: { attest?: boolean; integrity?: string } = {}) {
  return async (url: string, init?: { method?: string }) => {
    if (/\/-\/buddi-.+\.tgz$/.test(url)) {
      expect(init?.method).toBe('HEAD');
      return { status: 200, json: async () => ({}) };
    }
    if (url === `${REGISTRY}/%40withbuddi%2Fbuddi/latest`) return { status: 200, json: async () => ({ version: latest }) };
    const one = /%40withbuddi%2Fbuddi\/(.+)$/.exec(url);
    if (one) {
      const v = one[1]!;
      return {
        status: 200,
        json: async () => ({
          name: '@withbuddi/buddi', version: v,
          dist: {
            integrity: opts.integrity ?? INTEGRITY(v), tarball: `${REGISTRY}/@withbuddi/buddi/-/buddi-${v}.tgz`,
            ...(opts.attest === false ? {} : { attestations: { url: `${REGISTRY}/-/npm/v1/attestations/@withbuddi%2fbuddi@${v}`, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }),
          },
        }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
}

/** npm, as a fake: `install` lays the release out as npm would; `audit` answers what it is told. */
function fakeNpm(opts: { installed?: string; lockIntegrity?: string; audit?: string; failInstall?: string } = {}) {
  const calls: string[][] = [];
  const runner: NpmRunner = async (_bin, argv) => {
    calls.push(argv);
    const prefix = argv[argv.indexOf('--prefix') + 1]!;
    if (argv[0] === 'install') {
      if (opts.failInstall) throw Object.assign(new Error('failed'), { stderr: opts.failInstall });
      const spec = argv.find(a => a.startsWith('@withbuddi/buddi@'))!;
      const version = opts.installed ?? spec.slice('@withbuddi/buddi@'.length);
      const root = releaseRoot(prefix);
      await mkdir(path.join(root, 'packages/install/dist'), { recursive: true });
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version }));
      await writeFile(path.join(root, 'packages/install/dist/launcher.js'), '');
      await writeFile(path.join(prefix, 'package-lock.json'), JSON.stringify({
        packages: { 'node_modules/@withbuddi/buddi': { version, integrity: opts.lockIntegrity ?? INTEGRITY(version) } },
      }));
      return { stdout: '' };
    }
    if (argv[0] === 'audit') return { stdout: opts.audit ?? auditReport(argv.includes('--prefix') ? path.basename(prefix).replace('.staging-', '') : '') };
    throw new Error(`unexpected npm ${argv.join(' ')}`);
  };
  return { runner, calls };
}

/** Resolved: macOS's tmpdir sits under the `/var` → `/private/var` link, and staging resolves it. */
async function releasesDir(): Promise<string> {
  return path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-app-'))), 'releases');
}

describe('the app layout', () => {
  test('is the app\'s word in the environment, never a guess', () => {
    expect(appLayout({ [APP_LAYOUT_VAR]: '/Users/me/Library/Application Support/buddi/releases' })).toBe('/Users/me/Library/Application Support/buddi/releases');
    expect(appLayout({ [APP_LAYOUT_VAR]: 'relative/releases' })).toBeUndefined();
    expect(appLayout({ [APP_LAYOUT_VAR]: ' ' })).toBeUndefined();
    expect(appLayout({})).toBeUndefined();
  });

  test('a bundle is recognised from the root, and npm is never told to write there', () => {
    const root = '/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.0-pre.39';
    expect(insideAppBundle(root)).toBe(true);
    expect(insideAppBundle('/opt/homebrew/lib/node_modules/@withbuddi/buddi')).toBe(false);
    expect(upgradeTarget(root, { platform: 'darwin', manifest: () => undefined })).toEqual({ error: APP_BUNDLE });
  });

  test('hands over by exiting to the app', () => {
    expect(restartPlan({ platform: 'darwin', label: 'com.buddi.install.x', appLayout: true }).mode).toBe('app');
    expect(restartPlan({ platform: 'darwin', label: 'com.buddi.install.x', xpcServiceName: 'com.buddi.install.x' }).mode).toBe('launchd');
  });

  test('the way back is the app menu, not npm', () => {
    const entry = { from: '0.1.0-pre.39', to: '0.1.0-pre.40', startedAt: '', outcome: 'failed' as const, step: 'migrating', error: 'boom', backup: 'b.tar.gz' };
    expect(recoverySentence(entry, { app: true })).toContain('Restart with the Previous Version (0.1.0-pre.39)');
    expect(recoverySentence(entry, { app: true })).not.toContain('npm');
    expect(recoverySentence(entry)).toContain('npm install -g');
    const lines = upgradeDoctorLines({ ...versionView({ check: { enabled: true }, current: '0.1.0-pre.39', history: [entry] }), app: true }, 'upgrade-failed');
    expect(lines.at(-1)).toContain('Advanced → Restart with the Previous Version');
  });
});

describe('staging a release', () => {
  test('installs into its own folder, checks the integrity npm recorded, verifies provenance', async () => {
    const releases = await releasesDir();
    const npm = fakeNpm({ audit: auditReport('0.1.1') });
    const staged = await stageRelease({ releases, version: '0.1.1', registry: REGISTRY, http: registry('0.1.1') as never, exec: npm.runner, binary: 'npm' });
    expect(staged.dir).toBe(path.join(releases, 'buddi-0.1.1'));
    expect(staged.root).toBe(path.join(releases, 'buddi-0.1.1/node_modules/@withbuddi/buddi'));
    expect(npm.calls[0]).toEqual(['install', '--prefix', path.join(releases, '.staging-0.1.1'), '@withbuddi/buddi@0.1.1', '--registry', REGISTRY, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev']);
    expect(npm.calls[1]?.slice(0, 2)).toEqual(['audit', 'signatures']);
    expect(npm.calls[1]).toContain('--include-attestations');
    const record = JSON.parse(await readFile(path.join(staged.dir, 'release.json'), 'utf8'));
    expect(record).toMatchObject({ version: '0.1.1', integrity: INTEGRITY('0.1.1'), provenance: { verified: true, repository: 'https://github.com/withbuddi/buddi' } });
    expect(existsSync(path.join(releases, '.staging-0.1.1'))).toBe(false);
    // Nothing the app runs moved.
    expect(await releaseLinks(releases)).toEqual({});
  });

  test('installs under the resolved folder when the data folder sits behind a symlink', async () => {
    // npm writes `../../private/...` lock keys for a prefix under a link (measured: /var/folders on macOS).
    const real = await releasesDir();
    await mkdir(real, { recursive: true });
    const linked = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-link-'))), 'releases');
    await symlink(real, linked);
    const npm = fakeNpm({ audit: auditReport('0.1.1') });
    const staged = await stageRelease({ releases: linked, version: '0.1.1', registry: REGISTRY, http: registry('0.1.1') as never, exec: npm.runner, binary: 'npm' });
    expect(npm.calls[0]?.[2]).toBe(path.join(real, '.staging-0.1.1'));
    expect(staged.dir).toBe(path.join(real, 'buddi-0.1.1'));
  });

  test('refuses a tarball whose integrity is not the registry\'s, and leaves nothing behind', async () => {
    const releases = await releasesDir();
    const npm = fakeNpm({ lockIntegrity: 'sha512-c29tZXRoaW5nIGVsc2U=' });
    await expect(stageRelease({ releases, version: '0.1.1', registry: REGISTRY, http: registry('0.1.1') as never, exec: npm.runner, binary: 'npm' }))
      .rejects.toThrow(/integrity/);
    expect(existsSync(path.join(releases, 'buddi-0.1.1'))).toBe(false);
    expect(existsSync(path.join(releases, '.staging-0.1.1'))).toBe(false);
  });

  test('refuses a different version than the one asked for', async () => {
    const releases = await releasesDir();
    await expect(stageRelease({ releases, version: '0.1.1', registry: REGISTRY, http: registry('0.1.1') as never, exec: fakeNpm({ installed: '0.1.2' }).runner, binary: 'npm' }))
      .rejects.toThrow('npm installed 0.1.2 when 0.1.1 was asked for');
  });

  test('refuses an invalid or foreign provenance', async () => {
    const releases = await releasesDir();
    const stage = (audit: string) => stageRelease({ releases, version: '0.1.1', registry: REGISTRY, http: registry('0.1.1') as never, exec: fakeNpm({ audit }).runner, binary: 'npm' });
    await expect(stage(auditReport('0.1.1', { invalid: true }))).rejects.toThrow(/could not verify .*signature does not match/);
    await expect(stage(auditReport('0.1.1', { repository: 'https://github.com/someone/fork' }))).rejects.toThrow('was built from https://github.com/someone/fork');
    await expect(stage(auditReport('0.1.1', { noProvenance: true }))).rejects.toThrow(/did not verify a provenance attestation/);
  });

  test('from the public registry, a release without provenance is refused before npm runs', async () => {
    const releases = await releasesDir();
    const npm = fakeNpm();
    await expect(stageRelease({ releases, version: '0.1.1', registry: REGISTRY, requireProvenance: true, http: registry('0.1.1', { attest: false }) as never, exec: npm.runner, binary: 'npm' }))
      .rejects.toThrow(/no provenance attestation/);
    expect(npm.calls).toEqual([]);
  });

  test('from a registry of one\'s own, the record says provenance was not available', async () => {
    const releases = await releasesDir();
    const staged = await stageRelease({ releases, version: '0.1.1', registry: REGISTRY, http: registry('0.1.1', { attest: false }) as never, exec: fakeNpm().runner, binary: 'npm' });
    expect(staged.record.provenance).toEqual({ verified: false, reason: `${REGISTRY} serves no provenance for 0.1.1` });
  });

  test('the verdict reads the statement npm verified', () => {
    expect(provenanceVerdict(JSON.parse(auditReport('1.0.0', { repository: 'https://github.com/withbuddi/buddi.git' })), '1.0.0')).toBe('https://github.com/withbuddi/buddi.git');
    expect(() => provenanceVerdict({ invalid: [], missing: [{ name: '@withbuddi/buddi', version: '1.0.0' }] }, '1.0.0')).toThrow(/no registry signature/);
  });
});

describe('current and previous', () => {
  test('switch in one step and keep exactly two releases', async () => {
    const releases = await releasesDir();
    const bundle = '/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.0';
    for (const v of ['0.1.1', '0.1.2', '0.1.3']) await mkdir(releaseRoot(path.join(releases, `buddi-${v}`)), { recursive: true });
    await mkdir(path.join(releases, '.staging-0.1.9'), { recursive: true });

    await switchCurrent(releases, releaseRoot(path.join(releases, 'buddi-0.1.1')), bundle);
    expect(await releaseLinks(releases)).toEqual({ current: releaseRoot(path.join(releases, 'buddi-0.1.1')), previous: bundle });
    // Neither link uses 0.1.2, 0.1.3 or the stale staging folder.
    expect(existsSync(path.join(releases, 'buddi-0.1.2'))).toBe(false);
    expect(existsSync(path.join(releases, '.staging-0.1.9'))).toBe(false);

    await mkdir(releaseRoot(path.join(releases, 'buddi-0.1.4')), { recursive: true });
    await switchCurrent(releases, releaseRoot(path.join(releases, 'buddi-0.1.4')), releaseRoot(path.join(releases, 'buddi-0.1.1')));
    expect(await releaseLinks(releases)).toEqual({ current: releaseRoot(path.join(releases, 'buddi-0.1.4')), previous: releaseRoot(path.join(releases, 'buddi-0.1.1')) });
    expect((await stat(path.join(releases, 'buddi-0.1.1'))).isDirectory()).toBe(true);
    expect(await readlink(path.join(releases, 'current'))).toBe(releaseRoot(path.join(releases, 'buddi-0.1.4')));
    expect(await pruneReleases(releases)).toEqual([]);
  });

  test('never removes the release current points at when the folder is reached through a symlink', async () => {
    // Measured on macOS: a data folder under /var/folders (→ /private/var) once pruned the new release.
    const real = await releasesDir();
    const next = releaseRoot(path.join(real, 'buddi-0.1.1'));
    await mkdir(next, { recursive: true });
    const linked = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-link-'))), 'releases');
    await symlink(real, linked);
    await switchCurrent(linked, next, '/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.0');
    expect((await stat(next)).isDirectory()).toBe(true);
    expect(await releaseLinks(real)).toMatchObject({ current: next });
  });

  test('a stray file or link named like a release is left alone', async () => {
    const releases = await releasesDir();
    await mkdir(releases, { recursive: true });
    await writeFile(path.join(releases, 'buddi-notes.txt'), '');
    await symlink('/nowhere', path.join(releases, 'buddi-link'));
    expect(await pruneReleases(releases)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The whole upgrade, in the app's layout
 * ------------------------------------------------------------------ */

function backupControl(): BackupControl {
  const done: BackupJob = {
    id: 'b1', kind: 'backup', phase: 'done', phases: ['starting', 'done'],
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    report: { archive: 'buddi-backup-20260101-000000.tar.gz' },
  };
  return { create: () => done, busy: () => false, job: () => undefined, schedule: async () => ({ encryptLocal: true }), hasVault: () => true } as unknown as BackupControl;
}

async function appInstallation(): Promise<{ ctx: ReadyContext; releases: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-appinst-')));
  const root = path.join(base, 'buddi.app/Contents/Resources/buddi/buddi-0.1.0');
  const data = path.join(base, 'data');
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version: '0.1.0' }));
  const releases = path.join(data, 'releases');
  return {
    ctx: { root, data, env: { [APP_LAYOUT_VAR]: releases, BUDDI_NPM_REGISTRY: REGISTRY }, state: { version: 1, database: 'managed', webPort: 4317, dbPort: 5555, phase: 'ready' } },
    releases,
  };
}

async function finished(upgrade: ReturnType<typeof createUpgradeService>, id: string, restarted: () => boolean): Promise<BackupJob> {
  for (let i = 0; i < 3000; i++) {
    const job = upgrade.job(id);
    if (job?.finishedAt !== undefined || (job?.phase === 'restarting' && restarted())) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('the upgrade job never settled');
}

describe('an upgrade inside buddi.app', () => {
  function appService(ctx: ReadyContext, opts: Partial<Parameters<typeof createUpgradeService>[0]> = {}) {
    let restarted = false;
    const stopGateway = vi.fn(async () => {});
    const startGateway = vi.fn(() => {});
    const install = vi.fn(async () => {});
    const checkPostgres = vi.fn(async () => ({ ok: true as const }));
    const upgrade = createUpgradeService({
      ctx, current: '0.1.0', backup: backupControl(), stopGateway, startGateway, install, checkPostgres,
      http: registry('0.1.1') as never, npm: fakeNpm({ audit: auditReport('0.1.1') }).runner, log: () => {},
      ...opts,
      restart: () => { restarted = true; },
    });
    return { upgrade, stopGateway, startGateway, install, checkPostgres, restarted: () => restarted };
  }

  test('stages outside the bundle, switches current, keeps the bundle as previous, and hands over', async () => {
    const { ctx, releases } = await appInstallation();
    const s = appService(ctx);
    expect((await s.upgrade.view()).app).toBe(true);
    const job = await finished(s.upgrade, (s.upgrade.start() as BackupJob).id, s.restarted);
    expect(job.phase).toBe('restarting');
    expect(s.install).not.toHaveBeenCalled();
    const next = releaseRoot(path.join(releases, 'buddi-0.1.1'));
    expect(s.checkPostgres).toHaveBeenCalledWith(next);
    expect(await releaseLinks(releases)).toEqual({ current: next, previous: ctx.root });
    expect(s.stopGateway).toHaveBeenCalled();
    expect(ctx.state).toMatchObject({ phase: 'upgrading', upgrade: { from: '0.1.0', to: '0.1.1', backup: 'buddi-backup-20260101-000000.tar.gz' } });
    // The signed bundle was never written to.
    expect(existsSync(path.join(ctx.root, 'node_modules'))).toBe(false);
  });

  test('a release that fails verification changes nothing and never stops the gateway', async () => {
    const { ctx, releases } = await appInstallation();
    const s = appService(ctx, { npm: fakeNpm({ audit: auditReport('0.1.1', { invalid: true }) }).runner });
    const job = await finished(s.upgrade, (s.upgrade.start() as BackupJob).id, s.restarted);
    expect(job.phase).toBe('failed');
    expect(job.error).toMatch(/could not verify/);
    expect(s.stopGateway).not.toHaveBeenCalled();
    expect(await releaseLinks(releases)).toEqual({});
    expect((await s.upgrade.view()).history.at(-1)).toMatchObject({ outcome: 'failed', step: 'installing', to: '0.1.1' });
    expect(ctx.state.phase).toBe('ready');
  });

  test('a Postgres that does not start in the new release is discarded before the backup', async () => {
    const { ctx, releases } = await appInstallation();
    const s = appService(ctx, { checkPostgres: async () => ({ ok: false, error: 'dyld: Library not loaded.' }) });
    const job = await finished(s.upgrade, (s.upgrade.start('0.1.1') as BackupJob).id, s.restarted);
    expect(job.phase).toBe('failed');
    expect(job.error).toBe('dyld: Library not loaded. buddi did not switch to 0.1.1. It is still running on 0.1.0.');
    expect(s.stopGateway).not.toHaveBeenCalled();
    expect(existsSync(path.join(releases, 'buddi-0.1.1'))).toBe(false);
    expect(await releaseLinks(releases)).toEqual({});
  });
});
