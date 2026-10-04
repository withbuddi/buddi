/**
 * buddi.app's own layout: upgrades that never write into the signed bundle.
 *
 * The Mac app carries a release inside `buddi.app/Contents/Resources/buddi/`,
 * which is signed and sealed: `npm install --prefix` there would break the
 * signature, and the app would go on running the bundle's copy anyway. So the
 * app starts its supervisor with `BUDDI_APP_LAYOUT=<writable dir>` (it uses
 * `<data>/releases`), and an upgrade in that layout goes there instead:
 *
 *     <releases>/buddi-<version>/                      npm's prefix for that release
 *     <releases>/buddi-<version>/node_modules/@withbuddi/buddi   the release root
 *     <releases>/current  -> the release root the app runs
 *     <releases>/previous -> the root that ran before it (a release, or the bundle's copy)
 *
 * The app (`BundleLayout.swift`) starts whatever `current` points at, and the
 * bundle's copy when there is no `current`; the bundle's copy is never touched,
 * so it is always there to fall back on.
 *
 * Verification, before anything is switched:
 *
 *  - **Integrity.** The packument's `dist.integrity` (sha512) is read first,
 *    npm verifies the tarball against it while installing, and the
 *    `package-lock.json` npm wrote is read back to check that the integrity it
 *    recorded is that same value: what is on disk is the tarball npm serves.
 *  - **Provenance.** `npm audit signatures --include-attestations` verifies the
 *    registry signature and the sigstore provenance bundle with npm's own
 *    sigstore client (Fulcio certificate, Rekor inclusion, subject digest), and
 *    the SLSA statement it verified must name this repository as the source.
 *    Required from the public registry; a registry of one's own (the smoke, a
 *    mirror) has none to offer, and the record says so.
 *
 * Scripts stay off (`--ignore-scripts`, as everywhere in `upgrade.ts`); the one
 * install script the release needs, embedded Postgres's dylib links, is what
 * `createPostgresCheck` hydrates itself before it runs the new binary.
 *
 * Like `upgrade.ts`, nothing here reaches the network by itself: the registry
 * is the `http` seam and npm is the `exec` seam.
 */
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HttpTransport } from '@buddi/gateway';
import { DEFAULT_REGISTRY, PACKAGE_NAME, PACKAGE_PATH, CHECK_TIMEOUT_MS, npmBinary } from './upgrade.js';
import type { NpmRunner } from './upgrade.js';

/** What the app sets in its supervisor's environment: where releases go. */
export const APP_LAYOUT_VAR = 'BUDDI_APP_LAYOUT';

/**
 * The exit status that tells buddi.app "start me again from `current`, now".
 * EX_TEMPFAIL: not a crash, so the app counts no failure and waits no backoff.
 */
export const APP_RESTART_EXIT = 75;

/** The repository a release's provenance must name. */
export const SOURCE_REPOSITORY = 'https://github.com/withbuddi/buddi';

/** What a running supervisor inside a bundle says when the app did not start it. */
export const APP_BUNDLE =
  'This buddi runs from inside buddi.app, and the app updates it. Open buddi from the menu bar to update.';

/** `<releases>` when this installation is buddi.app's, else undefined. */
export function appLayout(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env[APP_LAYOUT_VAR]?.trim();
  return dir !== undefined && dir !== '' && path.isAbsolute(dir) ? path.resolve(dir) : undefined;
}

/** Does this root sit inside a macOS app bundle? */
export function insideAppBundle(root: string): boolean {
  return /\.app\/Contents\//.test(root.split(path.sep).join('/') + '/');
}

export function releaseDir(releases: string, version: string): string {
  return path.join(releases, `buddi-${version}`);
}

/** The package root inside a release directory, where npm puts it. */
export function releaseRoot(dir: string): string {
  return path.join(dir, 'node_modules', ...PACKAGE_NAME.split('/'));
}

/* ------------------------------------------------------------------ *
 * What the registry says about one version
 * ------------------------------------------------------------------ */

export interface ReleaseMeta {
  version: string;
  integrity: string;
  tarball: string;
  /** Where npm serves the provenance bundle, when the version has one. */
  attestations?: string;
}

/** One GET of `<registry>/@withbuddi%2Fbuddi/<version>`: the integrity and the provenance URL. */
export async function fetchReleaseMeta(registry: string, version: string, http: HttpTransport): Promise<ReleaseMeta> {
  const response = await http(`${registry.replace(/\/+$/, '')}/${PACKAGE_PATH}/${version}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`the registry answered ${response.status} for ${PACKAGE_NAME}@${version}`);
  const body = await response.json() as { version?: unknown; dist?: { integrity?: unknown; tarball?: unknown; attestations?: { url?: unknown } } };
  if (body.version !== version) throw new Error(`the registry described ${String(body.version)} when asked for ${version}`);
  const integrity = body.dist?.integrity;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) throw new Error(`${PACKAGE_NAME}@${version} has no sha512 integrity in the registry`);
  const tarball = typeof body.dist?.tarball === 'string' ? body.dist.tarball : '';
  const url = body.dist?.attestations?.url;
  return { version, integrity, tarball, ...(typeof url === 'string' && url !== '' ? { attestations: url } : {}) };
}

/* ------------------------------------------------------------------ *
 * npm, as this layout calls it
 * ------------------------------------------------------------------ */

export function stageArgs(prefix: string, version: string, registry: string): string[] {
  return [
    'install', '--prefix', prefix, `${PACKAGE_NAME}@${version}`,
    '--registry', registry,
    '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev',
  ];
}

export function auditArgs(prefix: string, registry: string): string[] {
  return ['audit', 'signatures', '--prefix', prefix, '--registry', registry, '--json', '--include-attestations'];
}

/** What `npm audit signatures --json --include-attestations` answers. */
interface AuditReport {
  invalid?: Array<{ name?: string; version?: string; code?: string; message?: string }>;
  missing?: Array<{ name?: string; version?: string }>;
  verified?: Array<{
    name?: string;
    version?: string;
    attestations?: { provenance?: unknown };
    attestationBundles?: Array<{ predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }>;
  }>;
}

/**
 * The provenance verdict on an audit report: verified, for this version, from
 * this repository. Throws with the reason otherwise. Returns the source
 * repository the statement names.
 */
export function provenanceVerdict(report: AuditReport, version: string, repository = SOURCE_REPOSITORY): string {
  const bad = (report.invalid ?? []).find(entry => entry.name === PACKAGE_NAME) ?? report.invalid?.[0];
  if (bad !== undefined) throw new Error(`npm could not verify ${bad.name ?? 'a package'}@${bad.version ?? '?'}: ${bad.message ?? bad.code ?? 'invalid signature'}`);
  if ((report.missing ?? []).some(entry => entry.name === PACKAGE_NAME)) throw new Error(`${PACKAGE_NAME}@${version} has no registry signature`);
  const ours = (report.verified ?? []).find(entry => entry.name === PACKAGE_NAME && entry.version === version);
  if (ours === undefined || ours.attestations?.provenance === undefined) throw new Error(`npm did not verify a provenance attestation for ${PACKAGE_NAME}@${version}`);
  const slsa = (ours.attestationBundles ?? []).find(b => b.predicateType?.startsWith('https://slsa.dev/provenance/') === true);
  const payload = slsa?.bundle?.dsseEnvelope?.payload;
  if (payload === undefined) throw new Error(`the provenance of ${PACKAGE_NAME}@${version} has no SLSA statement`);
  let source: unknown;
  try {
    const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { predicate?: { buildDefinition?: { externalParameters?: { workflow?: { repository?: unknown } } } } };
    source = statement.predicate?.buildDefinition?.externalParameters?.workflow?.repository;
  } catch { /* said below */ }
  if (typeof source !== 'string') throw new Error(`the provenance of ${PACKAGE_NAME}@${version} names no source repository`);
  if (source.replace(/\.git$/, '').toLowerCase() !== repository.toLowerCase()) throw new Error(`${PACKAGE_NAME}@${version} was built from ${source}, not ${repository}`);
  return source;
}

/** What `<release>/release.json` records about how a release was checked. */
export interface ReleaseRecord {
  version: string;
  integrity: string;
  provenance: { verified: true; url: string; repository: string } | { verified: false; reason: string };
  stagedAt: string;
}

export interface StageOptions {
  releases: string;
  version: string;
  registry: string;
  http: HttpTransport;
  exec: NpmRunner;
  binary?: string;
  /** Provenance is required unless this says otherwise; default: only from the public registry. */
  requireProvenance?: boolean;
  log?: (line: string) => void;
}

/**
 * Download, verify and unpack one release into `<releases>/buddi-<version>`.
 * Nothing the app runs changes here: `current` is switched later, by
 * `switchCurrent`, once the rest of the upgrade has said yes.
 */
export async function stageRelease(opts: StageOptions): Promise<{ dir: string; root: string; record: ReleaseRecord }> {
  const { version, registry } = opts;
  const binary = opts.binary ?? npmBinary();
  const requireProvenance = opts.requireProvenance ?? registry.replace(/\/+$/, '') === DEFAULT_REGISTRY;
  const timeout = 15 * 60_000;
  const maxBuffer = 64 * 1024 * 1024;
  const fail = (what: string, err: unknown): Error => {
    const stderr = (err as { stderr?: string } | null)?.stderr;
    const text = (stderr ?? (err instanceof Error ? err.message : String(err))).toString().trim();
    return new Error(`${what}: ${text.split('\n').slice(-8).join('\n')}`);
  };

  const meta = await fetchReleaseMeta(registry, version, opts.http);
  if (requireProvenance && meta.attestations === undefined) {
    throw new Error(`${PACKAGE_NAME}@${version} has no provenance attestation, and buddi.app installs only releases built by withbuddi/buddi's CI.`);
  }

  await mkdir(opts.releases, { recursive: true, mode: 0o700 });
  // Resolved: npm given a prefix under a symlink (`/var` → `/private/var`, a
  // linked home) writes its lock with `../../private/...` keys, and the
  // integrity check below would find nothing.
  const releases = await realpath(opts.releases);
  const staging = path.join(releases, `.staging-${version}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  // npm's own kind of prefix manifest: no name, so it is nobody's project.
  await writeFile(path.join(staging, 'package.json'), JSON.stringify({ private: true, description: 'A buddi release installed by buddi.app.' }, null, 2) + '\n');
  try {
    try { await opts.exec(binary, stageArgs(staging, version, registry), { timeout, maxBuffer }); }
    catch (err) { throw fail(`npm install ${PACKAGE_NAME}@${version} failed`, err); }

    // What npm recorded for what it unpacked: the integrity the registry named.
    const lock = JSON.parse(await readFile(path.join(staging, 'package-lock.json'), 'utf8').catch(() => '{}')) as { packages?: Record<string, { version?: string; integrity?: string }> };
    const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
    if (entry?.version !== version) throw new Error(`npm installed ${entry?.version ?? 'nothing'} when ${version} was asked for`);
    if (entry.integrity !== meta.integrity) throw new Error(`the installed tarball's integrity (${entry.integrity ?? 'none'}) is not the registry's (${meta.integrity})`);
    const pkg = JSON.parse(await readFile(path.join(releaseRoot(staging), 'package.json'), 'utf8').catch(() => '{}')) as { name?: string; version?: string };
    if (pkg.name !== PACKAGE_NAME || pkg.version !== version) throw new Error(`what was unpacked is ${pkg.name ?? 'not a package'} ${pkg.version ?? ''}, not ${PACKAGE_NAME}@${version}`.replace('  ', ' '));

    let provenance: ReleaseRecord['provenance'];
    if (meta.attestations !== undefined) {
      let out: unknown;
      try { out = await opts.exec(binary, auditArgs(staging, registry), { timeout, maxBuffer }); }
      catch (err) {
        // `audit signatures` exits non-zero on an invalid signature and still prints its JSON.
        const stdout = (err as { stdout?: string } | null)?.stdout;
        if (typeof stdout !== 'string' || stdout.trim() === '') throw fail('npm audit signatures failed', err);
        out = { stdout };
      }
      const text = typeof out === 'string' ? out : String((out as { stdout?: unknown } | null)?.stdout ?? '');
      let report: AuditReport;
      try { report = JSON.parse(text) as AuditReport; }
      catch { throw new Error('npm audit signatures did not answer with JSON'); }
      const repository = provenanceVerdict(report, version);
      provenance = { verified: true, url: meta.attestations, repository };
    } else {
      provenance = { verified: false, reason: `${registry} serves no provenance for ${version}` };
    }

    const record: ReleaseRecord = { version, integrity: meta.integrity, provenance, stagedAt: new Date().toISOString() };
    await writeFile(path.join(staging, 'release.json'), JSON.stringify(record, null, 2) + '\n');
    const dir = releaseDir(releases, version);
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
    opts.log?.(`upgrade: ${version} is staged in ${dir} (integrity ${provenance.verified ? 'and provenance ' : ''}verified).`);
    return { dir, root: releaseRoot(dir), record };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * current, previous, and what is kept
 * ------------------------------------------------------------------ */

async function linkTarget(link: string): Promise<string | undefined> {
  try { return path.resolve(path.dirname(link), await readlink(link)); }
  catch { return undefined; }
}

/** Replace a symlink in one rename, so the app never sees it missing. */
async function pointAt(link: string, target: string): Promise<void> {
  const tmp = `${link}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, link);
}

/** Where `current` and `previous` point now. */
export async function releaseLinks(releases: string): Promise<{ current?: string; previous?: string }> {
  const current = await linkTarget(path.join(releases, 'current'));
  const previous = await linkTarget(path.join(releases, 'previous'));
  return { ...(current === undefined ? {} : { current }), ...(previous === undefined ? {} : { previous }) };
}

/**
 * Point `current` at the new root and `previous` at the one running now, then
 * drop every release directory neither of them is in. The bundle's own copy is
 * outside `<releases>` and is never removed.
 */
export async function switchCurrent(target: string, next: string, running: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const releases = await realpath(target);
  await pointAt(path.join(releases, 'previous'), running);
  await pointAt(path.join(releases, 'current'), next);
  await pruneReleases(releases);
}

/** Remove release directories `current` and `previous` do not use, and stale staging. */
export async function pruneReleases(releases: string): Promise<string[]> {
  // Both sides resolved: a data folder under a symlink (`/var` → `/private/var`)
  // must never make the release `current` points at look like someone else's.
  const base = await realpath(releases).catch(() => releases);
  const targets = await Promise.all(['current', 'previous'].map(name => realpath(path.join(base, name)).catch(() => undefined)));
  const kept = new Set(targets.filter((p): p is string => p !== undefined).map(p => path.relative(base, p).split(path.sep)[0]));
  releases = base;
  const removed: string[] = [];
  for (const name of await readdir(releases).catch(() => [] as string[])) {
    if (!name.startsWith('buddi-') && !name.startsWith('.staging-')) continue;
    if (kept.has(name)) continue;
    const full = path.join(releases, name);
    if (!(await lstat(full)).isDirectory()) continue;
    await rm(full, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
