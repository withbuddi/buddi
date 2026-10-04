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
 *  - **Signatures.** `npm audit signatures --include-attestations` verifies the
 *    registry signature and the sigstore bundles with npm's own sigstore client
 *    (Fulcio chain, Rekor inclusion). The npm that ships with Node 22 answers
 *    `--json` with only `{ invalid, missing }`, so that is all this reads from
 *    it: nothing invalid, and this package not missing.
 *  - **Provenance.** Who signed is checked here (`provenance.ts`): the SLSA
 *    bundle the registry serves for this version chains to Fulcio, its
 *    signature verifies, its subject is the tarball's sha512, and its
 *    certificate names `withbuddi/buddi`'s release workflow at this version's
 *    tag. Required from the public registry; a registry of one's own (the
 *    smoke, a mirror) has none to offer, and the record says so.
 *
 * All of it happens in `<releases>/.staging-<v>-<random>`; only a release that
 * passed (and whose Postgres starts, see `upgrade.ts`) is renamed into
 * `buddi-<v>` by `placeRelease`, and a `buddi-<v>` that `current` or
 * `previous` points at is never removed to make room.
 *
 * Scripts stay off (`--ignore-scripts`, as everywhere in `upgrade.ts`); the one
 * install script the release needs, embedded Postgres's dylib links, is what
 * `createPostgresCheck` hydrates itself before it runs the new binary.
 *
 * Like `upgrade.ts`, nothing here reaches the network by itself: the registry
 * is the `http` seam and npm is the `exec` seam.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HttpTransport } from '@buddi/gateway';
import { DEFAULT_REGISTRY, PACKAGE_NAME, PACKAGE_PATH, CHECK_TIMEOUT_MS, authFor, npmBinary, sanitizeNpmOutput } from './upgrade.js';
import { attestationsUrl, verifyProvenance } from './provenance.js';
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

/** Does a supervisor with this install root run buddi.app's copy: the bundle's, or a release the app installed? */
export function runsAppCopy(installRoot: string, data: string): boolean {
  return insideAppBundle(installRoot) || installRoot.startsWith(path.join(data, 'releases') + path.sep);
}

/** What npm's buddi says when buddi.app already runs this installation. */
export const APP_RUNNING_LINE = 'buddi is already running from buddi.app; this command line talks to it.';

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
export async function fetchReleaseMeta(registry: string, version: string, http: HttpTransport, auth?: Record<string, string>): Promise<ReleaseMeta> {
  const base = registry.replace(/\/+$/, '');
  const response = await http(`${base}/${PACKAGE_PATH}/${version}`, {
    method: 'GET',
    headers: { accept: 'application/json', ...authFor(base, base, auth) },
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

/**
 * What `npm audit signatures --json --include-attestations` answers. npm 10
 * (Node 22's) prints only `invalid` and `missing`; npm 11 adds `verified`,
 * which nothing here needs.
 */
export interface AuditReport {
  invalid?: Array<{ name?: string; version?: string; code?: string; message?: string }>;
  missing?: Array<{ name?: string; version?: string }>;
}

/**
 * npm's verdict: nothing in the release failed its registry signature or its
 * sigstore bundle, and this package is not unsigned. Throws with the reason.
 */
export function auditVerdict(report: AuditReport, version: string): void {
  if (typeof report !== 'object' || report === null || (!Array.isArray(report.invalid) && !Array.isArray(report.missing))) {
    throw new Error('npm audit signatures answered with something other than its report');
  }
  const bad = (report.invalid ?? []).find(entry => entry.name === PACKAGE_NAME) ?? report.invalid?.[0];
  if (bad !== undefined) throw new Error(`npm could not verify ${bad.name ?? 'a package'}@${bad.version ?? '?'}: ${bad.message ?? bad.code ?? 'invalid signature'}`);
  if ((report.missing ?? []).some(entry => entry.name === PACKAGE_NAME)) throw new Error(`${PACKAGE_NAME}@${version} has no registry signature`);
}

/** What `<release>/release.json` records about how a release was checked. */
export interface ReleaseRecord {
  version: string;
  integrity: string;
  provenance: { verified: true; url: string; repository: string; workflow: string } | { verified: false; reason: string };
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
  /** The registry's credentials (`registryAuth`), sent to its origin only. */
  auth?: Record<string, string>;
  /** The CA chain provenance must chain to; Fulcio's by default. */
  chain?: readonly string[];
  log?: (line: string) => void;
}

/** A release that passed every check, still in its staging folder. */
export interface StagedRelease {
  /** `<releases>/.staging-<v>-<random>`: npm's prefix. */
  staging: string;
  /** The package root inside it, where the Postgres check runs. */
  root: string;
  record: ReleaseRecord;
}

/** The plain line a release that fails its provenance check is refused with. */
export function provenanceRefusal(version: string, reason: string): string {
  return `buddi did not update to ${version}: its provenance did not check out (${reason}).`;
}

/**
 * Download, verify and unpack one release into a staging folder of its own.
 * Nothing the app runs changes here, and no `buddi-<v>` is touched: the
 * release is put in place by `placeRelease` once the rest of the upgrade has
 * checked it, and `current` is switched later still, by `switchCurrent`.
 */
export async function stageRelease(opts: StageOptions): Promise<StagedRelease> {
  const { version, registry } = opts;
  const binary = opts.binary ?? npmBinary();
  const requireProvenance = opts.requireProvenance ?? registry.replace(/\/+$/, '') === DEFAULT_REGISTRY;
  const timeout = 15 * 60_000;
  const maxBuffer = 64 * 1024 * 1024;
  const fail = (what: string, err: unknown): Error => {
    const stderr = (err as { stderr?: string } | null)?.stderr;
    const text = (stderr ?? (err instanceof Error ? err.message : String(err))).toString().trim();
    return new Error(`${what}: ${sanitizeNpmOutput(text)}`);
  };

  const meta = await fetchReleaseMeta(registry, version, opts.http, opts.auth);
  if (requireProvenance && meta.attestations === undefined) {
    throw new Error(`${PACKAGE_NAME}@${version} has no provenance attestation, and buddi.app installs only releases built by withbuddi/buddi's CI.`);
  }

  await mkdir(opts.releases, { recursive: true, mode: 0o700 });
  // Resolved: npm given a prefix under a symlink (`/var` → `/private/var`, a
  // linked home) writes its lock with `../../private/...` keys, and the
  // integrity check below would find nothing.
  const releases = await realpath(opts.releases);
  const staging = path.join(releases, `.staging-${version}-${randomBytes(4).toString('hex')}`);
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
      auditVerdict(report, version);

      // Who signed: the bundle npm verified, read and checked here.
      const base = registry.replace(/\/+$/, '');
      const url = meta.attestations.startsWith(`${base}/`) ? meta.attestations : attestationsUrl(base, PACKAGE_NAME, version);
      const response = await opts.http(url, { method: 'GET', headers: { accept: 'application/json', ...authFor(url, base, opts.auth) }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (response.status !== 200) throw new Error(provenanceRefusal(version, `the registry answered ${response.status} for its attestations`));
      const doc = await response.json().catch(() => undefined);
      let facts: { repository: string; workflow: string };
      try { facts = verifyProvenance(doc, { name: PACKAGE_NAME, version, integrity: meta.integrity, ...(opts.chain === undefined ? {} : { chain: opts.chain }) }); }
      catch (err) { throw new Error(provenanceRefusal(version, err instanceof Error ? err.message : String(err))); }
      provenance = { verified: true, url, repository: facts.repository, workflow: facts.workflow };
    } else {
      provenance = { verified: false, reason: `${registry} serves no provenance for ${version}` };
    }

    const record: ReleaseRecord = { version, integrity: meta.integrity, provenance, stagedAt: new Date().toISOString() };
    await writeFile(path.join(staging, 'release.json'), JSON.stringify(record, null, 2) + '\n');
    opts.log?.(`upgrade: ${version} is downloaded to ${staging} (integrity ${provenance.verified ? 'and provenance ' : ''}verified).`);
    return { staging, root: releaseRoot(staging), record };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Is `dir` (a `buddi-<v>` in `releases`) the one `current` or `previous` points into? */
async function referenced(releases: string, dir: string): Promise<boolean> {
  const targets = await Promise.all(['current', 'previous'].map(name => realpath(path.join(releases, name)).catch(() => undefined)));
  return targets.some(target => target !== undefined && path.relative(releases, target).split(path.sep)[0] === path.basename(dir));
}

/**
 * Rename a checked staging folder into `<releases>/buddi-<version>`.
 *
 * A `buddi-<version>` already there that `current` or `previous` points at is
 * kept as it is (it passed the same checks when it was staged), and the new
 * copy is dropped: the release the app falls back on is never removed to make
 * room. One nothing points at is replaced.
 */
export async function placeRelease(target: string, version: string, staging: string, log?: (line: string) => void): Promise<{ dir: string; root: string; kept: boolean }> {
  const releases = await realpath(target);
  const dir = releaseDir(releases, version);
  const there = await lstat(dir).then(s => s.isDirectory(), () => false);
  if (there && await referenced(releases, dir)) {
    await rm(staging, { recursive: true, force: true });
    log?.(`upgrade: ${version} is already in ${dir} and the app may go back to it; keeping that copy.`);
    return { dir, root: releaseRoot(dir), kept: true };
  }
  if (there) {
    // rename(2) replaces only an empty directory: move the old one aside first.
    const aside = path.join(releases, `.staging-${version}-old-${randomBytes(4).toString('hex')}`);
    await rename(dir, aside);
    await rename(staging, dir);
    await rm(aside, { recursive: true, force: true }).catch(() => {});
  } else {
    await rename(staging, dir);
  }
  log?.(`upgrade: ${version} is in place in ${dir}.`);
  return { dir, root: releaseRoot(dir), kept: false };
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
