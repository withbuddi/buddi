import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
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
  auditVerdict,
  insideAppBundle,
  placeRelease,
  pruneReleases,
  releaseLinks,
  releaseRoot,
  stageRelease,
  switchCurrent,
} from './app-layout.js';
import { createUpgradeService, recoverySentence, restartPlan, upgradeDoctorLines, upgradeTarget, versionView } from './upgrade.js';
import type { NpmRunner } from './upgrade.js';
import { provenanceFixture } from './fixtures/provenance.js';
import type { FixtureOptions } from './fixtures/provenance.js';

const REGISTRY = 'https://registry.example';
const INTEGRITY = (v: string): string => `sha512-${Buffer.from(`tarball ${v}`).toString('base64')}`;
/** The test CA every provenance fixture here is signed by. */
const CHAIN = provenanceFixture({ version: '0.0.1', integrity: INTEGRITY('0.0.1') }).chain;

/** What npm 10 (Node 22's) prints for `audit signatures --json`: measured, nothing else. */
function auditReport(opts: { invalid?: boolean; missing?: boolean } = {}): string {
  if (opts.invalid) return JSON.stringify({ invalid: [{ name: '@withbuddi/buddi', version: '0.1.1', code: 'EATTESTATIONVERIFY', message: 'signature does not match' }], missing: [] });
  if (opts.missing) return JSON.stringify({ invalid: [], missing: [{ name: '@withbuddi/buddi', version: '0.1.1' }] });
  return JSON.stringify({ invalid: [], missing: [] });
}

/**
 * The registry, as a transport: `/latest`, one version's packument, the
 * tarball HEAD, and the provenance npm serves for the version.
 */
function registry(latest: string, opts: { attest?: boolean; integrity?: string; provenance?: Partial<FixtureOptions>; attestStatus?: number } = {}) {
  return async (url: string, init?: { method?: string }) => {
    if (/\/-\/buddi-.+\.tgz$/.test(url)) {
      expect(init?.method).toBe('HEAD');
      return { status: 200, json: async () => ({}) };
    }
    const attestation = /\/-\/npm\/v1\/attestations\/@withbuddi%2fbuddi@(.+)$/i.exec(url);
    if (attestation) {
      const v = attestation[1]!;
      if (opts.attestStatus !== undefined) return { status: opts.attestStatus, json: async () => ({}) };
      const { doc } = provenanceFixture({ version: v, integrity: opts.integrity ?? INTEGRITY(v), ...opts.provenance });
      return { status: 200, json: async () => doc };
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
    if (argv[0] === 'audit') return { stdout: opts.audit ?? auditReport() };
    throw new Error(`unexpected npm ${argv.join(' ')}`);
  };
  return { runner, calls };
}

/** Resolved: macOS's tmpdir sits under the `/var` → `/private/var` link, and staging resolves it. */
async function releasesDir(): Promise<string> {
  return path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-app-'))), 'releases');
}

/** What is left in the releases folder besides `current` and `previous`. */
async function leftovers(releases: string): Promise<string[]> {
  return (await readdir(releases).catch(() => [] as string[])).filter(name => name !== 'current' && name !== 'previous').sort();
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
  const stage = (releases: string, extra: Partial<Parameters<typeof stageRelease>[0]> = {}) =>
    stageRelease({ releases, version: '0.1.1', registry: REGISTRY, http: registry('0.1.1') as never, exec: fakeNpm().runner, binary: 'npm', chain: CHAIN, ...extra });

  test('installs into a staging folder of its own, checks the integrity npm recorded, verifies provenance', async () => {
    const releases = await releasesDir();
    const npm = fakeNpm();
    const staged = await stage(releases, { exec: npm.runner });
    expect(path.dirname(staged.staging)).toBe(releases);
    expect(path.basename(staged.staging)).toMatch(/^\.staging-0\.1\.1-[0-9a-f]{8}$/);
    expect(staged.root).toBe(path.join(staged.staging, 'node_modules/@withbuddi/buddi'));
    expect(npm.calls[0]).toEqual(['install', '--prefix', staged.staging, '@withbuddi/buddi@0.1.1', '--registry', REGISTRY, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev']);
    expect(npm.calls[1]?.slice(0, 2)).toEqual(['audit', 'signatures']);
    expect(npm.calls[1]).toContain('--include-attestations');
    const record = JSON.parse(await readFile(path.join(staged.staging, 'release.json'), 'utf8'));
    expect(record).toMatchObject({
      version: '0.1.1', integrity: INTEGRITY('0.1.1'),
      provenance: { verified: true, repository: 'https://github.com/withbuddi/buddi', workflow: 'https://github.com/withbuddi/buddi/.github/workflows/release.yml@refs/tags/v0.1.1' },
    });
    // Nothing the app runs moved, and no buddi-<v> exists until it is placed.
    expect(await releaseLinks(releases)).toEqual({});
    expect(existsSync(path.join(releases, 'buddi-0.1.1'))).toBe(false);
    const placed = await placeRelease(releases, '0.1.1', staged.staging);
    expect(placed).toEqual({ dir: path.join(releases, 'buddi-0.1.1'), root: releaseRoot(path.join(releases, 'buddi-0.1.1')), kept: false });
    expect(await leftovers(releases)).toEqual(['buddi-0.1.1']);
  });

  test('installs under the resolved folder when the data folder sits behind a symlink', async () => {
    // npm writes `../../private/...` lock keys for a prefix under a link (measured: /var/folders on macOS).
    const real = await releasesDir();
    await mkdir(real, { recursive: true });
    const linked = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-link-'))), 'releases');
    await symlink(real, linked);
    const npm = fakeNpm();
    const staged = await stage(linked, { exec: npm.runner });
    expect(path.dirname(npm.calls[0]![2]!)).toBe(real);
    expect((await placeRelease(linked, '0.1.1', staged.staging)).dir).toBe(path.join(real, 'buddi-0.1.1'));
  });

  test('refuses a tarball whose integrity is not the registry\'s, and leaves nothing behind', async () => {
    const releases = await releasesDir();
    await expect(stage(releases, { exec: fakeNpm({ lockIntegrity: 'sha512-c29tZXRoaW5nIGVsc2U=' }).runner })).rejects.toThrow(/integrity/);
    expect(await leftovers(releases)).toEqual([]);
  });

  test('refuses a different version than the one asked for', async () => {
    const releases = await releasesDir();
    await expect(stage(releases, { exec: fakeNpm({ installed: '0.1.2' }).runner })).rejects.toThrow('npm installed 0.1.2 when 0.1.1 was asked for');
  });

  test('refuses what npm could not verify, and an unsigned package', async () => {
    const releases = await releasesDir();
    await expect(stage(releases, { exec: fakeNpm({ audit: auditReport({ invalid: true }) }).runner })).rejects.toThrow(/could not verify .*signature does not match/);
    await expect(stage(releases, { exec: fakeNpm({ audit: auditReport({ missing: true }) }).runner })).rejects.toThrow(/no registry signature/);
    await expect(stage(releases, { exec: fakeNpm({ audit: '{"verified": 3}' }).runner })).rejects.toThrow(/other than its report/);
    expect(await leftovers(releases)).toEqual([]);
  });

  test('refuses a provenance from a fork, another tag, another tarball or nowhere, in one plain line', async () => {
    const releases = await releasesDir();
    const refused = (opts: Parameters<typeof registry>[1]) => stage(releases, { http: registry('0.1.1', opts) as never });
    await expect(refused({ provenance: { san: 'https://github.com/someone/buddi/.github/workflows/release.yml@refs/tags/v0.1.1' } }))
      .rejects.toThrow(/^buddi did not update to 0\.1\.1: its provenance did not check out \(it was signed by https:\/\/github\.com\/someone\/buddi/);
    await expect(refused({ provenance: { san: 'https://github.com/withbuddi/buddi/.github/workflows/release.yml@refs/tags/v0.1.0' } })).rejects.toThrow(/did not check out/);
    await expect(refused({ provenance: { integrity: INTEGRITY('something else') } })).rejects.toThrow(/different tarball/);
    await expect(refused({ attestStatus: 404 })).rejects.toThrow(/did not check out \(the registry answered 404/);
    // Signed by a CA other than the one trusted: the default is Fulcio's, and this fixture is not.
    await expect(stage(releases, { chain: undefined as never })).rejects.toThrow(/not issued by sigstore/);
    expect(await leftovers(releases)).toEqual([]);
  });

  test('from the public registry, a release without provenance is refused before npm runs', async () => {
    const releases = await releasesDir();
    const npm = fakeNpm();
    await expect(stage(releases, { requireProvenance: true, http: registry('0.1.1', { attest: false }) as never, exec: npm.runner }))
      .rejects.toThrow(/no provenance attestation/);
    expect(npm.calls).toEqual([]);
  });

  test('from a registry of one\'s own, the record says provenance was not available', async () => {
    const releases = await releasesDir();
    const staged = await stage(releases, { http: registry('0.1.1', { attest: false }) as never });
    expect(staged.record.provenance).toEqual({ verified: false, reason: `${REGISTRY} serves no provenance for 0.1.1` });
  });

  test('npm\'s verdict is read from the report npm 10 actually prints', () => {
    expect(() => auditVerdict({ invalid: [], missing: [] }, '1.0.0')).not.toThrow();
    // A dependency without a signature is not this package's problem; this package without one is.
    expect(() => auditVerdict({ invalid: [], missing: [{ name: '@embedded-postgres/darwin-arm64', version: '1' }] }, '1.0.0')).not.toThrow();
    expect(() => auditVerdict({ invalid: [], missing: [{ name: '@withbuddi/buddi', version: '1.0.0' }] }, '1.0.0')).toThrow(/no registry signature/);
  });
});

describe('putting a release in place', () => {
  async function staged(releases: string, version: string, marker: string): Promise<string> {
    const dir = path.join(releases, `.staging-${version}-${marker}`);
    await mkdir(releaseRoot(dir), { recursive: true });
    await writeFile(path.join(dir, 'marker'), marker);
    return dir;
  }

  test('keeps a copy previous points at, and replaces one nothing points at', async () => {
    const releases = await releasesDir();
    const kept = await staged(releases, '0.1.1', 'old');
    await placeRelease(releases, '0.1.1', kept);
    await switchCurrent(releases, '/Applications/buddi.app/Contents/Resources/buddi/buddi-0.1.0', releaseRoot(path.join(releases, 'buddi-0.1.1')));
    expect((await releaseLinks(releases)).previous).toBe(releaseRoot(path.join(releases, 'buddi-0.1.1')));

    const lines: string[] = [];
    const again = await placeRelease(releases, '0.1.1', await staged(releases, '0.1.1', 'new'), line => lines.push(line));
    expect(again.kept).toBe(true);
    expect(await readFile(path.join(releases, 'buddi-0.1.1/marker'), 'utf8')).toBe('old');
    expect(lines[0]).toMatch(/0\.1\.1 is already in .* keeping that copy/);
    expect(await leftovers(releases)).toEqual(['buddi-0.1.1']);

    await mkdir(path.join(releases, 'buddi-0.1.2'), { recursive: true });
    await writeFile(path.join(releases, 'buddi-0.1.2/marker'), 'stale');
    const fresh = await placeRelease(releases, '0.1.2', await staged(releases, '0.1.2', 'fresh'));
    expect(fresh.kept).toBe(false);
    expect(await readFile(path.join(releases, 'buddi-0.1.2/marker'), 'utf8')).toBe('fresh');
    expect(await leftovers(releases)).toEqual(['buddi-0.1.1', 'buddi-0.1.2']);
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
      http: registry('0.1.1') as never, npm: fakeNpm().runner, log: () => {}, provenanceChain: CHAIN,
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
    // Postgres is tried in the staging folder, before anything is renamed into place.
    expect(s.checkPostgres.mock.calls[0]).toEqual([expect.stringMatching(/\/\.staging-0\.1\.1-[0-9a-f]{8}\/node_modules\/@withbuddi\/buddi$/)]);
    expect(await releaseLinks(releases)).toEqual({ current: next, previous: ctx.root });
    expect(await leftovers(releases)).toEqual(['buddi-0.1.1']);
    expect(s.stopGateway).toHaveBeenCalled();
    expect(ctx.state).toMatchObject({ phase: 'upgrading', upgrade: { from: '0.1.0', to: '0.1.1', backup: 'buddi-backup-20260101-000000.tar.gz' } });
    // The signed bundle was never written to.
    expect(existsSync(path.join(ctx.root, 'node_modules'))).toBe(false);
  });

  test('a release that fails verification changes nothing and never stops the gateway', async () => {
    const { ctx, releases } = await appInstallation();
    const s = appService(ctx, { npm: fakeNpm({ audit: auditReport({ invalid: true }) }).runner });
    const job = await finished(s.upgrade, (s.upgrade.start() as BackupJob).id, s.restarted);
    expect(job.phase).toBe('failed');
    expect(job.error).toMatch(/could not verify/);
    expect(s.stopGateway).not.toHaveBeenCalled();
    expect(await releaseLinks(releases)).toEqual({});
    expect((await s.upgrade.view()).history.at(-1)).toMatchObject({ outcome: 'failed', step: 'installing', to: '0.1.1' });
    expect(ctx.state.phase).toBe('ready');
  });

  test('a release built anywhere but withbuddi/buddi\'s release workflow is refused in one plain line', async () => {
    const { ctx, releases } = await appInstallation();
    const s = appService(ctx, { http: registry('0.1.1', { provenance: { san: 'https://github.com/someone/buddi/.github/workflows/release.yml@refs/tags/v0.1.1' } }) as never });
    const job = await finished(s.upgrade, (s.upgrade.start() as BackupJob).id, s.restarted);
    expect(job.phase).toBe('failed');
    expect(job.error).toMatch(/^buddi did not update to 0\.1\.1: its provenance did not check out \(it was signed by https:\/\/github\.com\/someone\/buddi.*\)\.$/);
    expect(s.stopGateway).not.toHaveBeenCalled();
    expect(await leftovers(releases)).toEqual([]);
  });

  test('a retry after a rollback never breaks the release previous points at', async () => {
    const { ctx, releases } = await appInstallation();
    // 0.1.1 ran, and the owner went back to the bundle's 0.1.0: previous is 0.1.1.
    const old = releaseRoot(path.join(releases, 'buddi-0.1.1'));
    await mkdir(path.join(old, 'packages/install/dist'), { recursive: true });
    await writeFile(path.join(old, 'package.json'), JSON.stringify({ name: '@withbuddi/buddi', version: '0.1.1' }));
    await writeFile(path.join(old, 'packages/install/dist/launcher.js'), '// the copy that ran');
    await switchCurrent(releases, ctx.root, old);
    expect(await releaseLinks(releases)).toEqual({ current: ctx.root, previous: old });

    // The retry fails after staging: previous still runs.
    const failing = appService(ctx, { checkPostgres: async () => ({ ok: false, error: 'dyld: Library not loaded.' }) });
    expect((await finished(failing.upgrade, (failing.upgrade.start('0.1.1') as BackupJob).id, failing.restarted)).phase).toBe('failed');
    expect(await releaseLinks(releases)).toEqual({ current: ctx.root, previous: old });
    expect(await readFile(path.join(old, 'packages/install/dist/launcher.js'), 'utf8')).toBe('// the copy that ran');
    expect(await leftovers(releases)).toEqual(['buddi-0.1.1']);

    // The retry that passes keeps that copy, and switches to it.
    const passing = appService(ctx);
    expect((await finished(passing.upgrade, (passing.upgrade.start('0.1.1') as BackupJob).id, passing.restarted)).phase).toBe('restarting');
    expect(await releaseLinks(releases)).toEqual({ current: old, previous: ctx.root });
    expect(await readFile(path.join(old, 'packages/install/dist/launcher.js'), 'utf8')).toBe('// the copy that ran');
    expect(await leftovers(releases)).toEqual(['buddi-0.1.1']);
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
