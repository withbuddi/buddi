/**
 * Upgrading a packaged installation, from the inside.
 *
 * The owner's installation is one npm package (`buddi`) whose version is the
 * product version, and the supervisor is the only process that can safely
 * replace it: it owns the database, it owns the gateway child, and it is the
 * one thing that is still running while the code under it is being rewritten.
 * So the upgrade lives here rather than in the gateway or in a shell script.
 *
 * Four facts shape everything below.
 *
 *  - **A backup comes first.** Migrations only go forward (see
 *    `packages/cli/src/upgrade.ts`), so the answer to "it failed halfway" is
 *    the archive taken before it started, named in the history and in the one
 *    sentence the doctor prints.
 *  - **The step that cannot be undone happens in the *new* code.** Installing
 *    the package is reversible (`npm install -g @withbuddi/buddi@<previous>`); migrating
 *    is not. So the supervisor installs, records where it is in
 *    `installation.json`, and hands over — and the new supervisor migrates and
 *    writes the outcome. An upgrade interrupted anywhere is a `phase` on disk,
 *    never a guess.
 *  - **`--ignore-scripts`, here as everywhere else.** An upgrade is the one
 *    moment this installation runs `npm install` against the network, and it
 *    does it without letting any package in the tree run code. The Postgres
 *    binaries do not need it: the per-platform package ships them under
 *    `native/`, and `prepareBinaries` (`@buddi/core`, `postgres/binaries.ts`)
 *    copies that directory into `<data>/runtime` and creates the symlinks from
 *    the shipped `pg-symlinks.json` itself — which is also how the Docker image
 *    installs (scripts off) and why it works there.
 *  - **Nothing here reaches the network on its own.** The registry check is a
 *    seam (`http`), the npm call is a seam (`install`), and both are handed in
 *    by the supervisor. No unit test in this repository touches the network.
 *
 * `@buddi/*` packages arrive as arguments or as erased types, for the reason
 * given at the top of `environment.ts`: this module is loaded before
 * `environment()` has finished rewriting the environment whose path constants
 * those packages read at import time.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
/*
 * The one value import from a `@buddi/*` package in this file, and the reason
 * it is safe: `@buddi/core/semver` is a leaf module with no imports, no path
 * constants and no side effects, so loading it before `environment()` has
 * rewritten the environment cannot capture the wrong paths. Importing
 * `@buddi/core` itself would, which is what the note at the top forbids.
 */
import { compareSemver, parseSemver } from '@buddi/core/semver';
import type { HttpTransport } from '@buddi/gateway';
import { atomicJson, launchAgentLabel, SERVICE_UNIT_VAR } from './environment.js';
import type { InstallContext, ReadyContext } from './environment.js';
import { JobStore } from './backup.js';
import { createPostgresCheck } from './postgres-check.js';
import type { PostgresCheck } from './postgres-check.js';
import type { BackupControl, BackupJob } from './backup.js';
import { APP_BUNDLE, appLayout, insideAppBundle, placeRelease, pruneReleases, releaseDir, stageRelease, switchCurrent } from './app-layout.js';
import type { StagedRelease } from './app-layout.js';

const run = promisify(execFile);

/** Where `buddi` is published, and where the check and the install both look. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/**
 * The package on npmjs.com. Scoped, because npm refuses `buddi` as too close
 * to an existing package; the command is still `buddi`, only the install line
 * names the scope. The registry escapes the slash in a scoped name.
 */
export const PACKAGE_NAME = '@withbuddi/buddi';
export const PACKAGE_PATH = encodeURIComponent(PACKAGE_NAME);

/** Once a day, as the disclosure in Settings says. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How often the supervisor asks the gate above whether a check is due. */
export const TICK_INTERVAL_MS = 60 * 60 * 1000;

/** The registry is asked for one small document; it does not get long. */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * How long the successor of an upgrade has to answer on the socket.
 *
 * It starts a Postgres cluster and runs the migrations before it serves, so
 * this is a minute rather than a moment.
 */
export const HANDOVER_WAIT_MS = 60_000;

/** A backup that has not finished in this long is not going to. */
export const BACKUP_WAIT_MS = 20 * 60_000;

/** Enough history to see a pattern, few enough to read. */
export const HISTORY_LIMIT = 10;

/** The state of the once-a-day check. `enabled` is the owner's switch. */
export interface UpgradeCheckState {
  enabled: boolean;
  lastAt?: string;
  latest?: string;
  /** The release notes `latest` was published with (markdown). Only ever `latest`'s. */
  latestNotes?: string;
  /** What the registry did instead of answering. Never fails anything else. */
  error?: string;
  /**
   * `latest`, when npm names it but does not serve its tarball yet (the few
   * minutes after a publish): it is not offered until a check finds it served.
   */
  processing?: string;
}

/** One upgrade that reached an outcome. Nothing pending is ever in here. */
export interface UpgradeHistoryEntry {
  from: string;
  to: string;
  startedAt: string;
  finishedAt?: string;
  outcome: 'done' | 'failed' | 'rolled-back';
  /** The archive taken before the upgrade started. The way back. */
  backup?: string;
  error?: string;
  /** Which step failed: `backup`, `installing` or `migrating`. */
  step?: string;
}

/** `<data>/upgrade.json`. Read by the supervisor, the CLI and the gateway. */
export interface UpgradeState {
  check: UpgradeCheckState;
  current: string;
  registry?: string;
  history: UpgradeHistoryEntry[];
}

/** What `/version` answers, and what the dashboard renders. */
export interface VersionView {
  current: string;
  latest?: string;
  /** What changes in `latest`, as its release published it (markdown). */
  latestNotes?: string;
  checkedAt?: string;
  checkEnabled: boolean;
  updateAvailable: boolean;
  error?: string;
  /** The newer version npm is still processing, and the sentence that says so. Never offered meanwhile. */
  processing?: { version: string; message: string };
  history: UpgradeHistoryEntry[];
  /** buddi.app runs this installation: upgrades go to its releases folder, and the way back is its menu. */
  app?: true;
}

/** What an upgrade in progress records in `installation.json`. */
export interface UpgradeInProgress {
  from: string;
  to: string;
  backup?: string;
  startedAt: string;
}

export type UpgradeJob = BackupJob;

export function upgradeStateFile(data: string): string {
  return path.join(data, 'upgrade.json');
}

/** The registry this installation uses. The smoke serves its own. */
export function registryFor(env: NodeJS.ProcessEnv): string {
  const named = env.BUDDI_NPM_REGISTRY;
  return named !== undefined && named.trim() !== '' ? named.trim().replace(/\/+$/, '') : DEFAULT_REGISTRY;
}

/**
 * The version of the installed `buddi` package: the product version.
 *
 * `<root>/package.json` is the release manifest `scripts/release/build.mjs`
 * writes, and in a checkout it is the repository's own — the same number.
 */
export async function installedVersion(root: string): Promise<string> {
  return (await installedPackage(root)).version ?? 'unknown';
}

/**
 * The installed package's own name and version, as npm left them.
 *
 * Read back after every install rather than assumed: `npm install <spec>` is
 * capable of putting a different package, or a different version, at that path
 * — a registry that answers with something else, a tarball that is not what it
 * was said to be — and everything after this point (the migration under new
 * code, the history, the way back) is written in terms of what is actually
 * there now.
 */
export async function installedPackage(root: string): Promise<{ name?: string; version?: string }> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return {
      ...(typeof pkg.name === 'string' && pkg.name !== '' ? { name: pkg.name } : {}),
      ...(typeof pkg.version === 'string' && pkg.version !== '' ? { version: pkg.version } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * What a version has to look like before it is written down, sent to npm or
 * offered as an upgrade: one canonical release, nothing else.
 *
 * A range (`^1.2.0`), a tag (`latest`, `next`), an alias (`npm:other@1.0.0`),
 * a URL or a shell fragment are all things npm would happily install and this
 * installation could never reason about afterwards: the history would name a
 * version that is not what is on disk, and `updateAvailable` would compare a
 * word with a number. `latest` is resolved to one of these through the check
 * before it ever reaches npm.
 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

/**
 * -1, 0 or 1, or `undefined` when one of them is not a version.
 *
 * The comparison itself is `@buddi/core`'s, so the supervisor, the plugin
 * updater and the dashboard's disk fallback all answer "is that newer" the
 * same way, prereleases included.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseSemver(a), right = parseSemver(b);
  if (left === undefined || right === undefined) return undefined;
  return compareSemver(left, right);
}

export function isNewer(candidate: string | undefined, current: string): boolean {
  if (candidate === undefined || candidate === '') return false;
  const order = compareVersions(candidate, current);
  // A version nobody can parse — `unknown` from a package.json that would not
  // read — is never the older half of an upgrade this offers.
  return order !== undefined && order > 0;
}

function emptyState(current: string): UpgradeState {
  return { check: { enabled: true }, current, history: [] };
}

/** Read `<data>/upgrade.json`, tolerating everything a hand edit can do to it. */
export async function readUpgradeState(data: string, current: string): Promise<UpgradeState> {
  let parsed: Partial<UpgradeState> | undefined;
  try {
    parsed = JSON.parse(await readFile(upgradeStateFile(data), 'utf8')) as Partial<UpgradeState>;
  } catch {
    return emptyState(current);
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyState(current);
  const check: Partial<UpgradeCheckState> = typeof parsed.check === 'object' && parsed.check !== null ? parsed.check : {};
  return {
    check: {
      enabled: check.enabled !== false,
      ...(typeof check.lastAt === 'string' ? { lastAt: check.lastAt } : {}),
      ...(typeof check.latest === 'string' ? { latest: check.latest } : {}),
      ...(typeof check.latest === 'string' && typeof check.latestNotes === 'string' ? { latestNotes: check.latestNotes } : {}),
      ...(typeof check.error === 'string' ? { error: check.error } : {}),
      ...(typeof check.processing === 'string' && check.processing === check.latest ? { processing: check.processing } : {}),
    },
    current,
    ...(typeof parsed.registry === 'string' ? { registry: parsed.registry } : {}),
    history: Array.isArray(parsed.history) ? parsed.history.slice(-HISTORY_LIMIT) : [],
  };
}

/** Written 0600 through `atomicJson`, like every other file in the data directory. */
export async function writeUpgradeState(data: string, state: UpgradeState): Promise<void> {
  await atomicJson(upgradeStateFile(data), { ...state, history: state.history.slice(-HISTORY_LIMIT) });
}

export function versionView(state: UpgradeState): VersionView {
  const newer = isNewer(state.check.latest, state.current);
  const processing = newer && state.check.processing !== undefined && state.check.processing === state.check.latest ? state.check.processing : undefined;
  return {
    current: state.current,
    ...(state.check.latest === undefined ? {} : { latest: state.check.latest }),
    ...(state.check.latest === undefined || state.check.latestNotes === undefined ? {} : { latestNotes: state.check.latestNotes }),
    ...(state.check.lastAt === undefined ? {} : { checkedAt: state.check.lastAt }),
    checkEnabled: state.check.enabled,
    updateAvailable: newer && processing === undefined,
    ...(state.check.error === undefined ? {} : { error: state.check.error }),
    ...(processing === undefined ? {} : { processing: { version: processing, message: processingSentence(processing) } }),
    history: state.history,
  };
}

/** What the sheet and a failed install say while npm has not served a fresh version's tarball yet. */
export function processingSentence(version: string): string {
  return `npm is still processing ${version}; try again in a few minutes.`;
}

/**
 * Where npm serves a version's tarball by convention: `<registry>/@withbuddi/buddi/-/buddi-<version>.tgz`.
 * Only the fallback: the version document's `dist.tarball` is what npm itself downloads.
 */
export function tarballUrl(registry: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${PACKAGE_NAME}/-/${PACKAGE_NAME.split('/').pop()}-${version}.tgz`;
}

/**
 * The credentials npm itself would send to this registry, read from the
 * owner's npmrc (`NPM_CONFIG_USERCONFIG`, else `~/.npmrc`): `_authToken` as a
 * bearer, `_auth` or `username` + `_password` as basic. The longest
 * `//host/path/:` key the registry URL starts with wins, as in npm, and
 * `${VAR}` is read from the environment. Nothing found is no headers: the
 * public registry needs none.
 *
 * Read so the check and the install see the same registry: a mirror that wants
 * a token answered the anonymous check 401, which once read as "still
 * processing" for ever.
 */
export function registryAuth(registry: string, env: NodeJS.ProcessEnv, read: (file: string) => string = file => readFileSync(file, 'utf8')): Record<string, string> {
  const file = env.NPM_CONFIG_USERCONFIG ?? env.npm_config_userconfig ?? (env.HOME ? path.join(env.HOME, '.npmrc') : undefined);
  if (file === undefined) return {};
  let text: string;
  try { text = read(file); } catch { return {}; }
  let url: URL;
  try { url = new URL(registry.replace(/\/+$/, '') + '/'); } catch { return {}; }
  const nerf = `//${url.host}${url.pathname}`;
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const value = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? '');
    entries.set(trimmed.slice(0, eq).trim(), value);
  }
  const scopes = [...new Set([...entries.keys()].filter(k => k.startsWith('//') && k.includes('/:')).map(k => k.slice(0, k.lastIndexOf('/:') + 1)))]
    .filter(scope => nerf.startsWith(scope))
    .sort((a, b) => b.length - a.length);
  for (const scope of scopes) {
    const token = entries.get(`${scope}:_authToken`);
    if (token) return { authorization: `Bearer ${token}` };
    const auth = entries.get(`${scope}:_auth`);
    if (auth) return { authorization: `Basic ${auth}` };
    const user = entries.get(`${scope}:username`), password = entries.get(`${scope}:_password`);
    if (user && password) return { authorization: `Basic ${Buffer.from(`${user}:${Buffer.from(password, 'base64').toString('utf8')}`).toString('base64')}` };
  }
  return {};
}

/** Credentials go to the registry's own origin only, never to a host a document names. */
export function authFor(url: string, registry: string, auth: Record<string, string> | undefined): Record<string, string> {
  if (auth === undefined || Object.keys(auth).length === 0) return {};
  try { return new URL(url).origin === new URL(registry).origin ? auth : {}; } catch { return {}; }
}

export interface ServedOptions {
  /** `dist.tarball` from a version document already in hand; asked for otherwise. */
  tarball?: string | undefined;
  /** What `registryAuth` found: sent with every request to the registry's origin. */
  auth?: Record<string, string> | undefined;
}

/**
 * Does npm serve this version's tarball yet?
 *
 * The tarball is the one the version document names (`dist.tarball`), asked
 * with the registry's credentials. Only a 404 (of the document or the
 * tarball) is "still processing": that is what npmjs answers in the minutes
 * after a publish. A registry that refuses HEAD (405, 501) is asked for one
 * byte instead. Anything else — a 401 or 403 from a mirror, a 5xx — is not a
 * publish in progress and is not reported as one: the install that follows
 * says what is actually wrong. A transport failure throws.
 */
export async function tarballServed(registry: string, version: string, http: HttpTransport, opts: ServedOptions = {}): Promise<boolean> {
  const base = registry.replace(/\/+$/, '');
  let url = opts.tarball;
  if (url === undefined || url === '') {
    const doc = await http(`${base}/${PACKAGE_PATH}/${version}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...authFor(base, base, opts.auth) },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (doc.status === 404) return false;
    if (doc.status === 200) {
      const body = await doc.json().catch(() => undefined) as { dist?: { tarball?: unknown } } | undefined;
      if (typeof body?.dist?.tarball === 'string' && body.dist.tarball !== '') url = body.dist.tarball;
    }
  }
  if (url === undefined || url === '') url = tarballUrl(base, version);
  const headers = authFor(url, base, opts.auth);
  const head = await http(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (head.status >= 200 && head.status < 300) return true;
  if (head.status === 404) return false;
  if (head.status === 405 || head.status === 501) {
    try {
      const ranged = await http(url, { method: 'GET', headers: { ...headers, range: 'bytes=0-0' }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), maxBytes: 64 * 1024 });
      return ranged.status !== 404;
    } catch {
      // A server that ignored the range and started sending the whole tarball is serving it.
      return true;
    }
  }
  return true;
}

/**
 * npm's own words for *this package's* tarball not being served (yet): `E404`
 * and a 404 line naming `@withbuddi/buddi`. A 404 for anything else — a
 * dependency, a mirror's missing path — is not a publish in progress, and
 * keeps npm's own words.
 */
export function isNotFound(error: string): boolean {
  // The "npm install <spec> failed:" this module puts in front names the package itself.
  const said = error.replace(/npm (install|cache add) \S+ failed:/g, '');
  if (!/\bE404\b/.test(said)) return false;
  return said.split('\n').some(line => /\b404\b/.test(line) && /@withbuddi(\/|%2f)buddi\b/i.test(line));
}

/**
 * What npm said, safe to keep in the history and show on the dashboard:
 * credentials in URLs and npmrc-style tokens masked, terminal escapes and
 * other control characters dropped, the last eight lines.
 */
export function sanitizeNpmOutput(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/(\w+:\/\/)[^\s/@:]+(:[^\s/@]*)?@/g, '$1***@')
    .replace(/(_authToken|_auth|_password)(\s*[=:]\s*)\S+/gi, '$1$2***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 ***')
    .trim().split('\n').slice(-8).join('\n');
}

/** Release notes longer than this are cut; `build.mjs` keeps them to 8 KB. */
export const NOTES_LIMIT = 8 * 1024;

/** The newest published version, and the notes its release carried, if any. */
export interface LatestRelease {
  version: string;
  notes?: string;
  /** The document's `dist.tarball`: where `tarballServed` asks. */
  tarball?: string;
}

/**
 * Ask the registry for the newest published version.
 *
 * One GET of `<registry>/buddi/latest`, which is a few kilobytes at most — the
 * smallest question that answers "is there a newer buddi", and the reason
 * docs/install.md §10 can describe this outbound call in one sentence. The
 * same document carries the release notes (`buddi.notes`, written by
 * `scripts/release/build.mjs`), so they cost no second request.
 */
export async function fetchLatestRelease(registry: string, http: HttpTransport, auth?: Record<string, string>): Promise<LatestRelease> {
  const base = registry.replace(/\/+$/, '');
  const response = await http(`${base}/${PACKAGE_PATH}/latest`, {
    method: 'GET',
    headers: { accept: 'application/json', ...authFor(base, base, auth) },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`the registry answered ${response.status}`);
  const body = await response.json() as { version?: unknown; buddi?: { notes?: unknown }; dist?: { tarball?: unknown } };
  if (typeof body.version !== 'string' || body.version === '') throw new Error('the registry named no version');
  // Whatever that registry is, what it says becomes a spec for `npm install`
  // and a number on the dashboard. It gets to name a version, and nothing else.
  if (!isVersion(body.version)) throw new Error(`the registry named "${body.version}", which is not a version`);
  const tarball = typeof body.dist?.tarball === 'string' && body.dist.tarball !== '' ? { tarball: body.dist.tarball } : {};
  const notes = typeof body.buddi === 'object' && body.buddi !== null ? body.buddi.notes : undefined;
  if (typeof notes !== 'string' || notes.trim() === '') return { version: body.version, ...tarball };
  return { version: body.version, notes: notes.trim().slice(0, NOTES_LIMIT), ...tarball };
}


/* ------------------------------------------------------------------ *
 * Installing the package
 * ------------------------------------------------------------------ */

/** Where the installed `buddi` package sits, and how npm has to be told. */
export interface InstallTarget {
  /** `--prefix`. */
  prefix: string;
  /** Whether that prefix is a global one (`<prefix>/lib/node_modules`). */
  global: boolean;
}

/**
 * Read the layout back off the install root rather than trusting npm's config.
 *
 * `npm install -g` writes wherever the *invoking* npm's prefix points, which
 * is not necessarily where this installation actually lives: an owner who
 * installed with `--prefix`, a Node version manager switched since, or the
 * smoke's throwaway tree would all end up upgrading some other copy — or
 * creating a second one — while the running installation stayed exactly as it
 * was. The root we are running from is the only fact that cannot be wrong.
 */
export function installTarget(root: string, platform: NodeJS.Platform | string = process.platform): InstallTarget {
  // A scoped package sits one level deeper: `node_modules/@withbuddi/buddi`.
  let parent = path.dirname(root);
  if (path.basename(parent).startsWith('@')) parent = path.dirname(parent);
  if (path.basename(parent) === 'node_modules') {
    const grandparent = path.dirname(parent);
    // `<prefix>/lib/node_modules/buddi` is a global install everywhere but
    // Windows, whose global tree is `<prefix>/node_modules/buddi` — the same
    // shape as a plain install inside a project, which is why `upgradeTarget`
    // below refuses to guess between the two there.
    if (path.basename(grandparent) === 'lib' && platform !== 'win32') return { prefix: path.dirname(grandparent), global: true };
    return { prefix: grandparent, global: false };
  }
  return { prefix: parent, global: false };
}

/** The one sentence an installation this cannot upgrade in place gets. */
export const NOT_GLOBAL =
  'This buddi was installed inside another project; upgrade it there with npm.';

/**
 * Where npm may write, or why it may not.
 *
 * `npm install --prefix <somebody's project>` is not an upgrade of buddi: it
 * rewrites that project's `package.json` and its tree, for a project whose
 * owner never asked. So an installation that is not the global one is refused
 * in words rather than upgraded at a guess.
 *
 * "Global" is read off the path, and the exception is the prefix npm makes for
 * an installation of its own: `npm install --prefix <dir> buddi` into an empty
 * directory writes a `package.json` with nothing in it but `dependencies`,
 * which is what the release smoke and the local verification of this hand-over
 * both install into. A manifest with a `name` is somebody's project.
 *
 * On Windows the global tree and a project tree have the same shape, so there
 * is nothing to read: it is refused until that layout is known.
 */
export function upgradeTarget(
  root: string,
  opts: { platform?: NodeJS.Platform | string; manifest?: (prefix: string) => { name?: unknown } | undefined } = {},
): InstallTarget | { error: string } {
  const platform = opts.platform ?? process.platform;
  // The bundle is signed: npm must never write there. buddi.app upgrades it
  // through its own layout (`app-layout.ts`) when it is the one running buddi.
  if (insideAppBundle(root)) return { error: APP_BUNDLE };
  const target = installTarget(root, platform);
  if (target.global) return target;
  if (platform === 'win32') return { error: NOT_GLOBAL };
  const read = opts.manifest ?? ((prefix: string) => {
    try { return JSON.parse(readFileSync(path.join(prefix, 'package.json'), 'utf8')) as { name?: unknown }; }
    catch { return undefined; }
  });
  const manifest = read(target.prefix);
  if (manifest !== undefined && typeof manifest.name === 'string' && manifest.name !== '') return { error: NOT_GLOBAL };
  return target;
}

/** Replace the installed package with `spec`. Throws with npm's own stderr. */
export type UpgradeInstaller = (spec: string, opts: { registry: string; root: string; target?: InstallTarget }) => Promise<void>;

/**
 * The npm beside the running node, for the reason `plugins/npm.ts` gives: a
 * packaged installation runs a node it shipped, and installing its own
 * dependencies with whatever npm a login shell put on PATH would build native
 * packages against a different engine. Restated here in four lines rather than
 * imported, because nothing in this module may take a value import from a
 * `@buddi/*` package.
 */
export function npmBinary(execPath = process.execPath): string {
  const beside = path.join(path.dirname(execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return existsSync(beside) ? beside : process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function installArgs(spec: string, opts: { registry: string; root: string; target?: InstallTarget }): string[] {
  const target = opts.target ?? installTarget(opts.root);
  return [
    'install',
    ...(target.global ? ['-g'] : []),
    '--prefix', target.prefix,
    spec,
    '--registry', opts.registry,
    // Nothing in that tree runs code at install time. See the header.
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];
}

/**
 * Fetch and verify the tarball before anything in the install root is touched.
 *
 * Measured rather than guessed, in the release smoke: a registry that serves
 * the tarball under a `dist.integrity` that does not match its bytes — a
 * truncated download, a corrupted mirror, a tampered publish — makes
 * `npm install` fail with `EINTEGRITY` *after* it has begun replacing the
 * installed package, and what it leaves behind is a `<root>/node_modules/buddi`
 * with no `package.json`, no `packages/` and no launcher. The upgrade's own
 * recovery for a failed install is "start the old gateway again", and there is
 * no old gateway left to start: the installation is gone and only the backup
 * taken first can bring it back.
 *
 * `npm cache add` downloads and verifies the same tarball into npm's cache and
 * writes nothing else, so an integrity failure becomes the clean refusal the
 * design assumes — the tree untouched, buddi still running, the job failed at
 * `installing`. The install that follows finds the bytes in the cache.
 */
export function cacheArgs(spec: string, opts: { registry: string }): string[] {
  return ['cache', 'add', spec, '--registry', opts.registry];
}

/** `execFile`, as much of it as this needs. A seam, so no test runs npm. */
export type NpmRunner = (binary: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<unknown>;

/** A tarball on disk (`BUDDI_UPGRADE_SOURCE`) has no registry to verify against. */
function isLocalTarball(spec: string): boolean {
  return spec.endsWith('.tgz') || spec.endsWith('.tar.gz');
}

export function createInstaller(opts: { binary?: string; timeoutMs?: number; runner?: NpmRunner } = {}): UpgradeInstaller {
  const binary = opts.binary ?? npmBinary();
  const timeout = opts.timeoutMs ?? 15 * 60_000;
  const exec: NpmRunner = opts.runner ?? (async (bin, argv, where) => { await run(bin, argv, where); });
  const failed = (verb: string, spec: string, err: unknown): Error => {
    const stderr = (err as { stderr?: string } | null)?.stderr;
    const text = (stderr ?? (err instanceof Error ? err.message : String(err))).toString().trim();
    return new Error(`npm ${verb} ${spec} failed: ${sanitizeNpmOutput(text)}`);
  };
  return async (spec, where) => {
    if (!isLocalTarball(spec)) {
      try {
        await exec(binary, cacheArgs(spec, where), { timeout, maxBuffer: 32 * 1024 * 1024 });
      } catch (err) {
        throw failed('cache add', spec, err);
      }
    }
    try {
      await exec(binary, installArgs(spec, where), { timeout, maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      throw failed('install', spec, err);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Handing over to the new code
 * ------------------------------------------------------------------ */

export interface RestartPlan {
  mode: 'launchd' | 'systemd' | 'app' | 'spawn';
  reason: string;
}

/**
 * How this supervisor becomes the new supervisor.
 *
 * **The decision, from what `launcher.ts` actually installs.** The plist it
 * writes (`buildPlist`, `packages/cli/src/service/units.ts`) carries
 * `KeepAlive: true` and `ProgramArguments` of `[<node>, <root>/packages/
 * install/dist/launcher.js, supervise]` — an *absolute path into the install
 * root*, which `npm install -g @withbuddi/buddi@<next>` rewrites in place. So under
 * launchd the whole hand-over is `process.exit(0)`: launchd restarts the job
 * unconditionally (`KeepAlive: true` ignores the exit status) and runs the new
 * code from the same path, with the same environment, under the same job.
 *
 * Spawning a supervisor ourselves there would be actively wrong. launchd would
 * respawn its own child anyway the moment we exited, so the installation would
 * end up with two supervisors racing for one lock and one port, one of them
 * outside launchd's supervision and never restarted at login.
 *
 * Off launchd — `buddi --no-service`, a foreground `buddi supervise`, the
 * release smoke — nothing would start us again, so there we do spawn the new
 * launcher detached and wait for it to answer on the socket before exiting.
 *
 * **The test is identity, not parentage.** launchd puts the job's label in
 * `XPC_SERVICE_NAME`, so a supervisor that *is* this installation's launchd job
 * can say so. A parent pid of 1 cannot: every detached process is reparented to
 * pid 1 the moment its starter exits, so a `buddi --no-service` supervisor on a
 * machine that also has the plist installed used to read as launchd's and exit
 * into nothing, leaving the installation down until the next login.
 */
export function restartPlan(facts: { platform: NodeJS.Platform | string; label: string; xpcServiceName?: string | undefined; serviceUnit?: string | undefined; appLayout?: boolean | undefined }): RestartPlan {
  // buddi.app is this supervisor's parent: it starts the launcher `current`
  // points at again as soon as this exits with APP_RESTART_EXIT (app-layout.ts).
  if (facts.appLayout === true) {
    return { mode: 'app', reason: 'buddi.app starts the release `current` points at again' };
  }
  if (facts.platform === 'darwin' && facts.label !== '' && facts.xpcServiceName === facts.label) {
    return { mode: 'launchd', reason: 'launchd keeps this job alive and runs the launcher from the install root' };
  }
  // The unit sets BUDDI_SERVICE_UNIT to its own label (launcher.ts), and
  // `Restart=always` restarts the job whatever its exit status.
  if (facts.platform === 'linux' && facts.label !== '' && facts.serviceUnit === facts.label) {
    return { mode: 'systemd', reason: 'systemd keeps this unit alive and runs the launcher from the install root' };
  }
  return { mode: 'spawn', reason: 'nothing else would start the supervisor again' };
}

export interface HandOverOptions {
  ctx: InstallContext;
  /** `<root>/packages/install/dist/launcher.js`: the same path, new code. */
  launcher: string;
  /** The environment the supervisor was started with, before it grew secrets. */
  env: NodeJS.ProcessEnv;
  plan?: RestartPlan;
  log?: (line: string) => void;
  /** Injected in tests. */
  spawnProcess?: typeof import('node:child_process').spawn;
  /** Is the successor serving, and is it the new version? Injected in tests. */
  ready?: () => Promise<boolean>;
  waitMs?: number;
}

/** What the hand-over did, and whether anybody is serving afterwards. */
export interface HandOverResult {
  plan: RestartPlan;
  /** False only on the spawn path, and only when nothing ever answered. */
  ok: boolean;
  attempts: number;
}

/**
 * Start the successor, once this process has let go of the lock, the socket
 * and the database. Called after `supervise`'s cleanup, never before it.
 *
 * Readiness is the *socket answering with the new version*, not the lock file:
 * a successor that takes the lock and then dies bringing the cluster up would
 * look like a finished hand-over for exactly as long as it took to crash, and
 * this process would exit into an installation that is down. Waiting for
 * `/status` to name the version we installed is waiting for the thing the
 * owner actually asked for.
 */
export async function handOver(opts: HandOverOptions): Promise<HandOverResult> {
  const plan = opts.plan ?? restartPlan({ platform: process.platform, label: launchAgentLabel(opts.ctx.data), serviceUnit: process.env[SERVICE_UNIT_VAR] ?? opts.env[SERVICE_UNIT_VAR], xpcServiceName: process.env.XPC_SERVICE_NAME ?? opts.env.XPC_SERVICE_NAME, appLayout: appLayout(opts.env) !== undefined });
  const log = opts.log ?? ((line: string) => console.error(line));
  if (plan.mode === 'launchd' || plan.mode === 'systemd' || plan.mode === 'app') {
    log(`supervisor: exiting for the upgrade; ${plan.reason}.`);
    return { plan, ok: true, attempts: 0 };
  }
  const { spawn } = await import('node:child_process');
  const spawnProcess = opts.spawnProcess ?? spawn;
  const ready = opts.ready ?? (async () => false);
  const waitMs = opts.waitMs ?? HANDOVER_WAIT_MS;
  const launch = async (): Promise<void> => {
    const logFile = await open(path.join(opts.ctx.data, 'logs/supervisor.log'), 'a', 0o600);
    try {
      // The successor is ours, not launchd's, whatever started this process:
      // an inherited `XPC_SERVICE_NAME` would make it read its own hand-over
      // as launchd's and exit into nothing.
      const { XPC_SERVICE_NAME: _launchd, [SERVICE_UNIT_VAR]: _systemd, ...env } = opts.env;
      const child = spawnProcess(process.execPath, [opts.launcher, 'supervise'], {
        detached: true, stdio: ['ignore', logFile.fd, logFile.fd], env,
      });
      child.unref();
      log(`supervisor: started the upgraded supervisor (pid ${child.pid ?? '?'}); ${plan.reason}.`);
    } finally { await logFile.close(); }
  };
  // Two attempts, because the cheap failures here are transient: a socket the
  // old process had not finished unlinking, a cluster port still in TIME_WAIT.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await launch();
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (await ready().catch(() => false)) return { plan, ok: true, attempts: attempt };
      if (Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(`supervisor: the upgraded supervisor did not answer within ${Math.round(waitMs / 1000)} seconds${attempt === 1 ? '; trying once more' : ''}. Its log is logs/supervisor.log.`);
  }
  return { plan, ok: false, attempts: 2 };
}

/**
 * Ask a supervisor socket for `/status`, with no agent and nothing pooled.
 *
 * `fetch` cannot address a Unix socket and this module may not import the
 * gateway's transport, so this is `node:http`'s client: one request, one
 * answer, connection closed. It is the readiness test of the hand-over.
 */
export async function statusOnSocket(socket: string, timeoutMs = 2_000): Promise<{ current?: string; phase?: string } | undefined> {
  return await new Promise((resolve) => {
    const req = request({ socketPath: socket, path: '/status', method: 'GET', headers: { host: 'localhost' }, timeout: timeoutMs }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(undefined);
        try { resolve(JSON.parse(text) as { current?: string; phase?: string }); }
        catch { resolve(undefined); }
      });
    });
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve(undefined));
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * The recovery sentence
 * ------------------------------------------------------------------ */

/**
 * The one sentence an owner needs when a migration failed under new code: what
 * broke, which archive holds the data, and the two commands that go back. The
 * dashboard is not available in that state — the gateway is deliberately not
 * started — so this has to be complete on its own.
 */
export function recoverySentence(entry: UpgradeHistoryEntry, opts: { app?: boolean } = {}): string {
  const where = entry.step === 'starting' ? 'while starting' : 'while migrating';
  const head = `Upgrade to ${entry.to} failed ${where}: ${entry.error ?? 'unknown error'}. ` +
    `The backup taken first is ${entry.backup ?? 'not available'}. `;
  if (opts.app === true) {
    // buddi.app keeps the release that ran before; its menu goes back to it.
    return head + `In the buddi menu, choose Advanced → Restart with the Previous Version (${entry.from}), then restore ${entry.backup ?? 'that backup'} in Settings → Backups.`;
  }
  return head + `Reinstall with \`npm install -g ${PACKAGE_NAME}@${entry.from}\` and run \`buddi backup restore ${entry.backup ?? '<backup>'}\`.`;
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

/** What the control socket can ask for. Every verb answers at once. */
export interface UpgradeControl {
  view(): Promise<VersionView>;
  check(): Promise<VersionView>;
  setCheckEnabled(enabled: boolean): Promise<VersionView>;
  /** `202` with a job, or a status and an error when something else has the lever. */
  start(version?: string): UpgradeJob | { status: number; error: string };
  job(id: string): UpgradeJob | undefined;
  /** Is an upgrade under way? `/status` reports it and the socket refuses a second. */
  busy(): boolean;
  /** An hour has passed: run the daily check if it is due. */
  tick(now?: Date): Promise<void>;
  current: string;
}

export interface UpgradeServiceOptions {
  ctx: ReadyContext;
  current: string;
  /** The backup the upgrade takes first, and the restore it must not race. */
  backup: BackupControl;
  stopGateway: () => Promise<void>;
  startGateway: () => void;
  /** Shut down and hand over to the newly installed code. Never returns. */
  restart: () => void;
  install?: UpgradeInstaller | undefined;
  /** npm, as buddi.app's layout runs it (install into a release folder, audit signatures). A seam for tests. */
  npm?: NpmRunner | undefined;
  /** Does the newly installed Postgres binary start? Asked before the hand-over. */
  checkPostgres?: PostgresCheck | undefined;
  /** The CA chain a release's provenance must chain to; Fulcio's unless a test brings its own. */
  provenanceChain?: readonly string[] | undefined;
  http?: HttpTransport | undefined;
  log?: ((line: string) => void) | undefined;
  checkIntervalMs?: number | undefined;
  /** How long the backup before the upgrade may take. Shortened in tests. */
  backupWaitMs?: number | undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpgradeService(opts: UpgradeServiceOptions): UpgradeControl {
  const { ctx, backup, current } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const jobs = new JobStore();
  const registry = registryFor(ctx.env);
  /** What npm would send this registry; the check asks with the same. */
  const auth = registryAuth(registry, ctx.env);
  const checkInterval = opts.checkIntervalMs ?? (Number(ctx.env.BUDDI_UPGRADE_CHECK_INTERVAL_MS) || CHECK_INTERVAL_MS);
  const install = opts.install ?? createInstaller();
  const checkPostgres = opts.checkPostgres ?? createPostgresCheck({ env: ctx.env });
  const backupWait = opts.backupWaitMs ?? BACKUP_WAIT_MS;
  /** buddi.app's releases folder, when the app runs this installation. */
  const releases = appLayout(ctx.env);
  const npm: NpmRunner = opts.npm ?? (async (bin, argv, where) => await run(bin, argv, where));
  const dressed = (view: VersionView): VersionView => releases === undefined ? view : { ...view, app: true };
  let running: UpgradeJob | undefined;
  /** Has the code under this process already been replaced? See `perform`. */
  let replaced = false;

  const read = (): Promise<UpgradeState> => readUpgradeState(ctx.data, current);
  const save = async (state: UpgradeState): Promise<UpgradeState> => {
    const next: UpgradeState = { ...state, current, registry, history: state.history.slice(-HISTORY_LIMIT) };
    await writeUpgradeState(ctx.data, next);
    return next;
  };

  const runCheck = async (): Promise<UpgradeState> => {
    const state = await read();
    const at = new Date().toISOString();
    if (opts.http === undefined) {
      return await save({ ...state, check: { ...state.check, lastAt: at, error: 'this installation has no outbound transport' } });
    }
    try {
      const latest = await fetchLatestRelease(registry, opts.http, auth);
      // npm names a fresh version minutes before it serves the tarball; until
      // it does, the version is known but not offered (Upgrade would 404).
      const served = !isNewer(latest.version, current) || await tarballServed(registry, latest.version, opts.http, { tarball: latest.tarball, auth });
      // A check that answered clears the error a check that did not left, and
      // the notes are always the ones this answer carried: notes kept from an
      // older `latest` would describe the wrong release.
      return await save({ ...state, check: {
        enabled: state.check.enabled, lastAt: at, latest: latest.version,
        ...(latest.notes === undefined ? {} : { latestNotes: latest.notes }),
        ...(served ? {} : { processing: latest.version }),
      } });
    } catch (err) {
      // A registry that did not answer changes nothing but the error: the last
      // version we learned is still the last version we learned.
      return await save({ ...state, check: { ...state.check, lastAt: at, error: message(err) } });
    }
  };

  /**
   * Wait for the backup the upgrade started. The only job it ever awaits.
   *
   * With a deadline, because everything after this waits behind it: a dump
   * that hangs on a wedged disk would otherwise leave an upgrade "running"
   * for ever, refusing every other maintenance verb along with it.
   */
  const settled = async (job: BackupJob, waitMs: number): Promise<BackupJob | undefined> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (job.finishedAt !== undefined) return job;
      if (Date.now() > deadline) return undefined;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };

  const record = async (entry: UpgradeHistoryEntry): Promise<void> => {
    const state = await read();
    await save({ ...state, history: [...state.history, entry] });
  };

  /**
   * The version this upgrade is for, as a version.
   *
   * `latest` is a word, and a word cannot be compared, recorded or checked
   * against what npm actually installed. The last check usually knows the
   * number already; when it does not, this is what asks.
   */
  const resolveVersion = async (asked: string | undefined): Promise<{ version: string } | { error: string }> => {
    if (asked !== undefined) {
      return isVersion(asked) ? { version: asked } : { error: `"${asked}" is not a version this can install.` };
    }
    const kept = (await read()).check;
    if (isNewer(kept.latest, current) && kept.processing === undefined) return { version: kept.latest as string };
    const state = await runCheck();
    if (state.check.processing !== undefined) return { error: processingSentence(state.check.processing) };
    if (isVersion(state.check.latest)) return { version: state.check.latest };
    return { error: state.check.error ?? 'the registry did not name a version to upgrade to' };
  };

  const perform = async (job: UpgradeJob, version: string | undefined): Promise<void> => {
    const startedAt = new Date().toISOString();
    const source = ctx.env.BUDDI_UPGRADE_SOURCE?.trim();
    // A tarball on disk instead of a registry spec: what the release smoke
    // upgrades from, and the only way to exercise this path offline. Its
    // version is not knowable in advance; it is read back off the install.
    const tarball = source !== undefined && source !== '' ? path.resolve(source) : undefined;
    let to = version ?? 'unknown';
    let archive: string | undefined;
    /** Everything that ends an upgrade before the new code is on disk. */
    const give = async (step: string, error: string, restart: boolean): Promise<void> => {
      jobs.finish(job, 'failed', { error, ...(archive === undefined ? {} : { report: { backup: archive } }) });
      await record({ from: current, to, startedAt, finishedAt: new Date().toISOString(), outcome: 'failed', step, error, ...(archive === undefined ? {} : { backup: archive }) });
      if (restart) {
        // The old code is still on disk and still correct: start it again.
        opts.startGateway();
        log(`upgrade: ${step} failed, buddi is still running on ${current}: ${error}`);
      } else log(`upgrade: ${step} failed: ${error}`);
    };

    if (releases !== undefined) return await performInApp(job, version, releases, give, startedAt, (next) => { to = next; }, (taken) => { archive = taken; });

    // Where npm may write, decided before anything is stopped or archived.
    const target = upgradeTarget(ctx.root);
    if ('error' in target) return await give('checking', target.error, false);

    let spec = tarball;
    if (spec === undefined) {
      const resolved = await resolveVersion(version);
      if ('error' in resolved) return await give('checking', resolved.error, false);
      to = resolved.version;
      spec = `${PACKAGE_NAME}@${resolved.version}`;
      // Asked before the backup and the stop: a version npm is still
      // processing would only reach npm's 404 after both.
      if (opts.http !== undefined) {
        const served = await tarballServed(registry, to, opts.http, { auth }).catch(() => undefined);
        if (served === false) return await give('checking', processingSentence(to), false);
      }
    }

    const taken = await takeBackup(job);
    if ('error' in taken) return await give('backup', taken.error, false);
    archive = taken.archive;

    jobs.phase(job, 'stopping', 'stopping the gateway; the database stays up');
    await opts.stopGateway();

    jobs.phase(job, 'installing', `installing ${spec}`);
    try {
      await install(spec, { registry, root: ctx.root, target });
    } catch (err) {
      // npm's 404 wall for a version it has not served yet is one sentence here.
      const said = message(err);
      return await give('installing', tarball === undefined && isNotFound(said) ? processingSentence(to) : said, true);
    }

    /*
     * What is on disk now, rather than what was asked for. npm can be pointed
     * at a registry that answers with a different package, and a tarball is
     * whatever it is; migrating under code that is not the code this upgrade
     * decided on is the failure this refuses to walk into.
     */
    const installed = await installedPackage(ctx.root);
    if (installed.name !== PACKAGE_NAME || !isVersion(installed.version)) {
      return await give('installing', `what was installed is ${installed.name ?? 'not a package'} ${installed.version ?? ''}`.trim() + ', not buddi at a version this can read', true);
    }
    if (tarball === undefined && installed.version !== to) {
      return await give('installing', `${to} was asked for and ${installed.version} was installed`, true);
    }
    to = installed.version;

    /*
     * The new code's database has to start, and this is the last moment the
     * old code can still say no: past the hand-over a Postgres that dies in
     * the loader is a supervisor looping "Postgres failed to start" with
     * nothing to go back to. So the binary is run here, from the new install,
     * and a failure puts the previous version back on disk and starts its
     * gateway again — the database never stopped.
     */
    if (ctx.state.database !== 'external') {
      jobs.phase(job, 'verifying', `checking that ${to} can start its database`);
      const verdict = await checkPostgres(ctx.root);
      if (!verdict.ok) {
        const refused = `${verdict.error} buddi did not switch to ${to}.`;
        if (!isVersion(current)) return await give('verifying', `${refused} Reinstall the previous version with npm before restarting.`, false);
        jobs.phase(job, 'rolling-back', `reinstalling ${current}`);
        try {
          await install(`${PACKAGE_NAME}@${current}`, { registry, root: ctx.root, target });
          const back = await installedPackage(ctx.root);
          if (back.version !== current) throw new Error(`${back.version ?? 'nothing'} is installed`);
        } catch (err) {
          return await give('verifying', `${refused} Putting ${current} back also failed (${message(err)}); run \`npm install -g ${PACKAGE_NAME}@${current}\` before restarting.`, false);
        }
        return await give('verifying', `${refused} It is still running on ${current}.`, true);
      }
    }

    await handOverTo(job, to, startedAt, archive);
  };

  /**
   * The backup every upgrade takes first. Encrypted exactly as the schedule
   * says, because that setting is the owner's answer to "may an archive of
   * everything sit on this disk in the clear", and an upgrade is not an
   * exception to it.
   */
  const takeBackup = async (job: UpgradeJob): Promise<{ archive: string | undefined } | { error: string }> => {
    const schedule = await backup.schedule().catch(() => undefined);
    const encrypt = schedule?.encryptLocal !== false;
    if (encrypt && !backup.hasVault()) {
      return { error: 'This installation has no vault, so the backup an upgrade takes first cannot be encrypted. Turn off "Encrypt local backups" in Settings, or set up a vault.' };
    }
    jobs.phase(job, 'backup', 'taking a backup before anything changes');
    const started = backup.create(encrypt);
    if ('status' in started) return { error: started.error };
    const done = await settled(started, backupWait);
    if (done === undefined) return { error: 'the backup did not finish within twenty minutes' };
    if (done.phase !== 'done') return { error: done.error ?? 'the backup did not finish' };
    return { archive: (done.report as { archive?: string } | undefined)?.archive };
  };

  /**
   * buddi.app's upgrade: the new release goes into `<releases>/buddi-<v>`,
   * verified and checked while the gateway still runs, and only then is there
   * a backup, a stop and the switch of `current`. See `app-layout.ts`.
   */
  const performInApp = async (
    job: UpgradeJob, version: string | undefined, dir: string,
    give: (step: string, error: string, restart: boolean) => Promise<void>,
    startedAt: string, setTo: (to: string) => void, setArchive: (archive: string | undefined) => void,
  ): Promise<void> => {
    if (ctx.env.BUDDI_UPGRADE_SOURCE?.trim()) return await give('checking', 'buddi.app upgrades from the registry only; BUDDI_UPGRADE_SOURCE is for npm installations.', false);
    const resolved = await resolveVersion(version);
    if ('error' in resolved) return await give('checking', resolved.error, false);
    const to = resolved.version;
    setTo(to);
    if (opts.http === undefined) return await give('checking', 'this installation has no outbound transport', false);
    const served = await tarballServed(registry, to, opts.http, { auth }).catch(() => undefined);
    if (served === false) return await give('checking', processingSentence(to), false);
    const base = await realpath(dir).catch(() => dir);
    if ((path.resolve(ctx.root) + path.sep).startsWith(releaseDir(base, to) + path.sep)) {
      return await give('checking', `${to} is the version running.`, false);
    }

    /*
     * Everything is checked in a staging folder of its own, and only a release
     * that passed every check is renamed into `buddi-<v>`: a failed retry never
     * touches a `buddi-<v>` that `previous` (after a rollback) still points at.
     */
    jobs.phase(job, 'installing', `downloading and verifying ${to}`);
    let staged: StagedRelease;
    try {
      staged = await stageRelease({ releases: dir, version: to, registry, http: opts.http, exec: npm, log, auth, ...(opts.provenanceChain === undefined ? {} : { chain: opts.provenanceChain }) });
    } catch (err) {
      const said = message(err);
      return await give('installing', isNotFound(said) ? processingSentence(to) : said, false);
    }
    const dropStaging = async (): Promise<void> => { await rm(staged.staging, { recursive: true, force: true }).catch(() => {}); };

    if (ctx.state.database !== 'external') {
      jobs.phase(job, 'verifying', `checking that ${to} can start its database`);
      const verdict = await checkPostgres(staged.root);
      if (!verdict.ok) {
        await dropStaging();
        return await give('verifying', `${verdict.error} buddi did not switch to ${to}. It is still running on ${current}.`, false);
      }
    }

    let placed: { dir: string; root: string };
    try {
      placed = await placeRelease(dir, to, staged.staging, log);
    } catch (err) {
      await dropStaging();
      return await give('installing', `could not put ${to} in place: ${message(err)}`, false);
    }
    // Only what neither link uses goes: a kept `buddi-<v>` that `previous` names stays.
    const discard = async (): Promise<void> => { await pruneReleases(dir).catch(() => []); };

    const taken = await takeBackup(job);
    if ('error' in taken) { await discard(); return await give('backup', taken.error, false); }
    setArchive(taken.archive);

    jobs.phase(job, 'stopping', 'stopping the gateway; the database stays up');
    await opts.stopGateway();
    try {
      await switchCurrent(dir, placed.root, ctx.root);
    } catch (err) {
      return await give('installing', `could not switch to ${to}: ${message(err)}`, true);
    }
    await handOverTo(job, to, startedAt, taken.archive);
  };

  /** The point of no return, shared by both layouts. */
  const handOverTo = async (job: UpgradeJob, to: string, startedAt: string, archive: string | undefined): Promise<void> => {
    replaced = true;
    jobs.phase(job, 'restarting', `handing over to ${to}`);
    /*
     * The point of no return, written down before it is taken. From here the
     * process that finishes this upgrade is a different one, and the only
     * thing that connects them is this record: the new supervisor migrates,
     * writes the history entry and clears the marker. An interruption in
     * between leaves `state.upgrade` on disk, which is exactly the state the
     * next start knows how to finish.
     *
     * Nothing below starts the old gateway again. The code under it has
     * already been replaced, so "still running on the version it had" stopped
     * being true one line above: what is down here is down until the new
     * supervisor brings it up.
     */
    try {
      ctx.state.phase = 'upgrading';
      ctx.state.upgrade = { from: current, to, startedAt, ...(archive === undefined ? {} : { backup: archive }) };
      await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
      log(`upgrade: installed ${to}; handing over.`);
      opts.restart();
    } catch (err) {
      const error = message(err);
      jobs.finish(job, 'failed', { error, ...(archive === undefined ? {} : { report: { backup: archive } }) });
      await record({ from: current, to, startedAt, finishedAt: new Date().toISOString(), outcome: 'failed', step: 'restarting', error, ...(archive === undefined ? {} : { backup: archive }) }).catch(() => {});
      log(`upgrade: ${to} is installed but the hand-over could not be written: ${error}. Run buddi again; the new code is what will start.`);
      // Still the new code's installation: hand over anyway rather than start
      // last month's gateway against a database the new code is about to own.
      opts.restart();
    }
  };

  return {
    current,

    async view() {
      return dressed(versionView(await read()));
    },

    async check() {
      return dressed(versionView(await runCheck()));
    },

    async setCheckEnabled(enabled) {
      const state = await read();
      return dressed(versionView(await save({ ...state, check: { ...state.check, enabled } })));
    },

    start(version) {
      if (version !== undefined && !isVersion(version)) {
        return { status: 400, error: `"${version}" is not a version this can install.` };
      }
      if (running !== undefined) return { status: 409, error: 'An upgrade is already running.' };
      if (backup.busy()) return { status: 409, error: 'A restore is running.' };
      const job = jobs.start('upgrade');
      running = job;
      void (async () => {
        try {
          await perform(job, version);
        } catch (err) {
          jobs.finish(job, 'failed', { error: message(err) });
          log(`upgrade: failed: ${message(err)}`);
          // Only while the old code is still the installed code.
          if (!replaced) opts.startGateway();
        } finally {
          running = undefined;
        }
      })();
      return job;
    },

    job: id => jobs.get(id),

    busy: () => running !== undefined,

    async tick(now = new Date()) {
      if (running !== undefined) return;
      // An installation whose migration failed is waiting for its owner, not
      // for news: the one thing it must not do is offer another upgrade.
      if (ctx.state.phase === 'upgrade-failed') return;
      const state = await read();
      if (!state.check.enabled) return;
      const last = state.check.lastAt === undefined ? 0 : Date.parse(state.check.lastAt);
      if (Number.isFinite(last) && now.getTime() - last < checkInterval) return;
      await runCheck();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Finishing an upgrade in the new code
 * ------------------------------------------------------------------ */

/**
 * The outcome of the migration the new supervisor runs, written where the
 * dashboard, the CLI and the doctor all read it from.
 *
 * On success the phase goes back to `ready` and the entry says `done`. On
 * failure the phase stays `upgrade-failed`, the entry names the step, and the
 * caller does not start the gateway: running last month's gateway against a
 * half-migrated schema is the one outcome worse than being down.
 */
export async function finishUpgrade(ctx: ReadyContext, pending: UpgradeInProgress, outcome: { ok: true } | { ok: false; error: string }, step = 'migrating'): Promise<UpgradeHistoryEntry> {
  /*
   * Whose code finished this, rather than whose code was meant to.
   *
   * The recovery an owner is told to run is `npm install -g @withbuddi/buddi@<from>`,
   * and the supervisor that comes up afterwards finds the same marker and
   * migrates happily — the migration that broke is not in that tree any more.
   * Calling that `done: <from> to <to>` would put a version that is not
   * installed into the history as a success. The marker is still cleared:
   * this upgrade is over, whatever it reached.
   */
  const installed = await installedVersion(ctx.root);
  const wrongBuild = outcome.ok && installed !== pending.to;
  const resolved = wrongBuild
    ? { ok: false as const, error: `buddi ${installed} finished an upgrade that was meant to reach ${pending.to}`, step: 'finishing' }
    : { ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), step };
  const entry: UpgradeHistoryEntry = {
    from: pending.from,
    to: pending.to,
    startedAt: pending.startedAt,
    finishedAt: new Date().toISOString(),
    outcome: resolved.ok ? 'done' : 'failed',
    ...(pending.backup === undefined ? {} : { backup: pending.backup }),
    ...(resolved.ok ? {} : { step: resolved.step, error: resolved.error as string }),
  };
  // What is on disk is what `current` says, here as everywhere else.
  const current = installed === 'unknown' ? pending.to : installed;
  const state = await readUpgradeState(ctx.data, current);
  await writeUpgradeState(ctx.data, { ...state, current, history: [...state.history, entry] });
  /*
   * `upgrade-failed` is the state that keeps the gateway down until an owner
   * has been through the checklist, and it belongs to a start that failed —
   * not to this one, which came up on code that runs. So the wrong-build case
   * is recorded and then left `ready`: the installation opens, and the
   * history is what says the upgrade did not reach what it aimed at.
   */
  ctx.state.phase = outcome.ok ? 'ready' : 'upgrade-failed';
  if (outcome.ok) delete ctx.state.upgrade;
  await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
  return entry;
}

/** The `upgrade` row `buddi doctor` prints, in a packaged installation. */
export function upgradeDoctorLines(view: VersionView, phase: string | undefined): string[] {
  const lines = [`Version: ${view.current}${view.updateAvailable ? ` (${view.latest} is available)` : ''}`];
  lines.push(view.checkedAt === undefined
    ? `Update check: ${view.checkEnabled ? 'on, not run yet' : 'off'}`
    : `Update check: ${view.checkEnabled ? 'on' : 'off'}, last at ${view.checkedAt}${view.error === undefined ? '' : ` (${view.error})`}`);
  const last = view.history[view.history.length - 1];
  if (last !== undefined) {
    lines.push(`Last upgrade: ${last.from} to ${last.to}, ${last.outcome}${last.step === undefined ? '' : ` at ${last.step}`}`);
    if (phase === 'upgrade-failed' && last.outcome === 'failed') lines.push(recoverySentence(last, { app: view.app === true }));
  }
  return lines;
}
