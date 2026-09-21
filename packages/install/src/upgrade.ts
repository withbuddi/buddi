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
 *    the package is reversible (`npm install -g buddi@<previous>`); migrating
 *    is not. So the supervisor installs, records where it is in
 *    `installation.json`, and hands over — and the new supervisor migrates and
 *    writes the outcome. An upgrade interrupted anywhere is a `phase` on disk,
 *    never a guess.
 *  - **`--ignore-scripts` is wrong here**, and this is the one place in the
 *    repository where that is true. The Postgres binary package's own install
 *    script is what puts a cluster on disk (docs/install.md §2), and it is
 *    npm's dependency of *our own* package, approved by the owner the moment
 *    they asked for the upgrade. Plugins are the opposite case; see
 *    `packages/gateway/src/plugins/npm.ts`.
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
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HttpTransport } from '@buddi/gateway';
import { atomicJson, launchAgentPlist } from './environment.js';
import type { InstallContext, ReadyContext } from './environment.js';
import { JobStore } from './backup.js';
import type { BackupControl, BackupJob } from './backup.js';

const run = promisify(execFile);

/** Where `buddi` is published, and where the check and the install both look. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Once a day, as the disclosure in Settings says. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How often the supervisor asks the gate above whether a check is due. */
export const TICK_INTERVAL_MS = 60 * 60 * 1000;

/** The registry is asked for one small document; it does not get long. */
export const CHECK_TIMEOUT_MS = 10_000;

/** Enough history to see a pattern, few enough to read. */
export const HISTORY_LIMIT = 10;

/** The state of the once-a-day check. `enabled` is the owner's switch. */
export interface UpgradeCheckState {
  enabled: boolean;
  lastAt?: string;
  latest?: string;
  /** What the registry did instead of answering. Never fails anything else. */
  error?: string;
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
  checkedAt?: string;
  checkEnabled: boolean;
  updateAvailable: boolean;
  error?: string;
  history: UpgradeHistoryEntry[];
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
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Compare two versions the way a release train moves: numerically, field by
 * field, with a prerelease sorting before the release it leads to.
 *
 * Not a semver implementation, and not pretending to be one: `buddi` publishes
 * `x.y.z`, and the only question ever asked here is "is that one newer".
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): { numbers: number[]; pre: string } => {
    const [core = '', pre = ''] = value.trim().replace(/^v/, '').split('-', 2);
    return { numbers: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre };
  };
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function isNewer(candidate: string | undefined, current: string): boolean {
  if (candidate === undefined || candidate === '' || current === 'unknown') return false;
  return compareVersions(candidate, current) > 0;
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
      ...(typeof check.error === 'string' ? { error: check.error } : {}),
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
  return {
    current: state.current,
    ...(state.check.latest === undefined ? {} : { latest: state.check.latest }),
    ...(state.check.lastAt === undefined ? {} : { checkedAt: state.check.lastAt }),
    checkEnabled: state.check.enabled,
    updateAvailable: isNewer(state.check.latest, state.current),
    ...(state.check.error === undefined ? {} : { error: state.check.error }),
    history: state.history,
  };
}

/**
 * Ask the registry for the newest published version.
 *
 * One GET of `<registry>/buddi/latest`, which is a few hundred bytes — the
 * smallest question that answers "is there a newer buddi", and the reason
 * docs/install.md §10 can describe this outbound call in one sentence.
 */
export async function fetchLatestVersion(registry: string, http: HttpTransport): Promise<string> {
  const response = await http(`${registry.replace(/\/+$/, '')}/buddi/latest`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`the registry answered ${response.status}`);
  const body = await response.json() as { version?: unknown };
  if (typeof body.version !== 'string' || body.version === '') throw new Error('the registry named no version');
  return body.version;
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
export function installTarget(root: string): InstallTarget {
  const parent = path.dirname(root);
  if (path.basename(parent) === 'node_modules') {
    const grandparent = path.dirname(parent);
    // `<prefix>/lib/node_modules/buddi` is a global install everywhere but
    // Windows, where the global tree is `<prefix>/node_modules/buddi` — the
    // same shape as a plain local install, which is what the smoke makes.
    if (path.basename(grandparent) === 'lib') return { prefix: path.dirname(grandparent), global: true };
    return { prefix: grandparent, global: process.platform === 'win32' };
  }
  return { prefix: parent, global: false };
}

/** Replace the installed package with `spec`. Throws with npm's own stderr. */
export type UpgradeInstaller = (spec: string, opts: { registry: string; root: string }) => Promise<void>;

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

export function installArgs(spec: string, opts: { registry: string; root: string }): string[] {
  const target = installTarget(opts.root);
  return [
    'install',
    ...(target.global ? ['-g'] : []),
    '--prefix', target.prefix,
    spec,
    '--registry', opts.registry,
    // The one place this is right. See the header.
    '--ignore-scripts=false',
    '--no-audit',
    '--no-fund',
  ];
}

export function createInstaller(opts: { binary?: string; timeoutMs?: number } = {}): UpgradeInstaller {
  const binary = opts.binary ?? npmBinary();
  const timeout = opts.timeoutMs ?? 15 * 60_000;
  return async (spec, where) => {
    try {
      await run(binary, installArgs(spec, where), { timeout, maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      const stderr = (err as { stderr?: string } | null)?.stderr;
      const text = (stderr ?? (err instanceof Error ? err.message : String(err))).toString().trim();
      throw new Error(`npm install ${spec} failed: ${text.split('\n').slice(-8).join('\n')}`);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Handing over to the new code
 * ------------------------------------------------------------------ */

export interface RestartPlan {
  mode: 'launchd' | 'spawn';
  reason: string;
}

/**
 * How this supervisor becomes the new supervisor.
 *
 * **The decision, from what `launcher.ts` actually installs.** The plist it
 * writes (`buildPlist`, `packages/cli/src/service/units.ts`) carries
 * `KeepAlive: true` and `ProgramArguments` of `[<node>, <root>/packages/
 * install/dist/launcher.js, supervise]` — an *absolute path into the install
 * root*, which `npm install -g buddi@<next>` rewrites in place. So under
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
 * The test is deliberately narrow: our own plist, and launchd as our parent.
 * A detached supervisor is also reparented to pid 1, which is why the plist
 * has to be there too.
 */
export function restartPlan(facts: { platform: NodeJS.Platform | string; ppid: number; plist: string }): RestartPlan {
  if (facts.platform === 'darwin' && facts.ppid === 1 && existsSync(facts.plist)) {
    return { mode: 'launchd', reason: 'launchd keeps this job alive and runs the launcher from the install root' };
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
  /** Is the successor listening yet? Injected in tests. */
  alive?: () => Promise<boolean>;
  waitMs?: number;
}

/**
 * Start the successor, once this process has let go of the lock, the socket
 * and the database. Called after `supervise`'s cleanup, never before it.
 */
export async function handOver(opts: HandOverOptions): Promise<RestartPlan> {
  const plan = opts.plan ?? restartPlan({ platform: process.platform, ppid: process.ppid, plist: launchAgentPlist(opts.ctx.data) });
  const log = opts.log ?? ((line: string) => console.error(line));
  if (plan.mode === 'launchd') {
    log(`supervisor: exiting for the upgrade; ${plan.reason}.`);
    return plan;
  }
  const { spawn } = await import('node:child_process');
  const spawnProcess = opts.spawnProcess ?? spawn;
  const logFile = await open(path.join(opts.ctx.data, 'logs/supervisor.log'), 'a', 0o600);
  try {
    const child = spawnProcess(process.execPath, [opts.launcher, 'supervise'], {
      detached: true, stdio: ['ignore', logFile.fd, logFile.fd], env: opts.env,
    });
    child.unref();
    log(`supervisor: started the upgraded supervisor (pid ${child.pid ?? '?'}); ${plan.reason}.`);
  } finally { await logFile.close(); }
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  const alive = opts.alive ?? (async () => false);
  for (;;) {
    if (await alive().catch(() => false)) return plan;
    if (Date.now() > deadline) {
      log('supervisor: the upgraded supervisor did not answer within 30 seconds; its log is logs/supervisor.log.');
      return plan;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
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
export function recoverySentence(entry: UpgradeHistoryEntry): string {
  const where = entry.step === 'starting' ? 'while starting' : 'while migrating';
  return `Upgrade to ${entry.to} failed ${where}: ${entry.error ?? 'unknown error'}. ` +
    `The backup taken first is ${entry.backup ?? 'not available'}. ` +
    `Reinstall with \`npm install -g buddi@${entry.from}\` and run \`buddi backup restore ${entry.backup ?? '<backup>'}\`.`;
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
  http?: HttpTransport | undefined;
  log?: ((line: string) => void) | undefined;
  checkIntervalMs?: number | undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpgradeService(opts: UpgradeServiceOptions): UpgradeControl {
  const { ctx, backup, current } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const jobs = new JobStore();
  const registry = registryFor(ctx.env);
  const checkInterval = opts.checkIntervalMs ?? (Number(ctx.env.BUDDI_UPGRADE_CHECK_INTERVAL_MS) || CHECK_INTERVAL_MS);
  const install = opts.install ?? createInstaller();
  let running: UpgradeJob | undefined;

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
      const latest = await fetchLatestVersion(registry, opts.http);
      // A check that answered clears the error a check that did not left.
      return await save({ ...state, check: { enabled: state.check.enabled, lastAt: at, latest } });
    } catch (err) {
      // A registry that did not answer changes nothing but the error: the last
      // version we learned is still the last version we learned.
      return await save({ ...state, check: { ...state.check, lastAt: at, error: message(err) } });
    }
  };

  /** Wait for a backup job the upgrade started. The only job it ever awaits. */
  const settled = async (job: BackupJob): Promise<BackupJob> => {
    for (;;) {
      if (job.finishedAt !== undefined) return job;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };

  const record = async (entry: UpgradeHistoryEntry): Promise<void> => {
    const state = await read();
    await save({ ...state, history: [...state.history, entry] });
  };

  const perform = async (job: UpgradeJob, version: string | undefined): Promise<void> => {
    const startedAt = new Date().toISOString();
    const source = ctx.env.BUDDI_UPGRADE_SOURCE;
    // A tarball on disk instead of a registry spec: what the release smoke
    // upgrades from, and the only way to exercise this path offline.
    const spec = source !== undefined && source.trim() !== '' ? path.resolve(source.trim()) : `buddi@${version ?? 'latest'}`;
    let archive: string | undefined;

    jobs.phase(job, 'backup', 'taking a backup before anything changes');
    const started = backup.create(undefined);
    if ('status' in started) {
      jobs.finish(job, 'failed', { error: started.error });
      await record({ from: current, to: version ?? 'latest', startedAt, finishedAt: new Date().toISOString(), outcome: 'failed', step: 'backup', error: started.error });
      return;
    }
    const done = await settled(started);
    if (done.phase !== 'done') {
      const error = done.error ?? 'the backup did not finish';
      jobs.finish(job, 'failed', { error });
      await record({ from: current, to: version ?? 'latest', startedAt, finishedAt: new Date().toISOString(), outcome: 'failed', step: 'backup', error });
      return;
    }
    archive = (done.report as { archive?: string } | undefined)?.archive;

    jobs.phase(job, 'stopping', 'stopping the gateway; the database stays up');
    await opts.stopGateway();

    jobs.phase(job, 'installing', `installing ${spec}`);
    try {
      await install(spec, { registry, root: ctx.root });
    } catch (err) {
      const error = message(err);
      jobs.finish(job, 'failed', { error, ...(archive === undefined ? {} : { report: { backup: archive } }) });
      await record({ from: current, to: version ?? 'latest', startedAt, finishedAt: new Date().toISOString(), outcome: 'failed', step: 'installing', error, ...(archive === undefined ? {} : { backup: archive }) });
      // The old code is still on disk and still correct: start it again.
      opts.startGateway();
      log(`upgrade: the install failed, buddi is still running on ${current}: ${error}`);
      return;
    }

    const to = await installedVersion(ctx.root);
    jobs.phase(job, 'restarting', `handing over to ${to}`);
    /*
     * The point of no return, written down before it is taken. From here the
     * process that finishes this upgrade is a different one, and the only
     * thing that connects them is this record: the new supervisor migrates,
     * writes the history entry and clears the phase. An interruption in
     * between leaves `phase: upgrading` on disk, which is exactly the state
     * the next start knows how to finish.
     */
    ctx.state.phase = 'upgrading';
    ctx.state.upgrade = { from: current, to, startedAt, ...(archive === undefined ? {} : { backup: archive }) };
    await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
    log(`upgrade: installed ${to}; handing over.`);
    opts.restart();
  };

  return {
    current,

    async view() {
      return versionView(await read());
    },

    async check() {
      return versionView(await runCheck());
    },

    async setCheckEnabled(enabled) {
      const state = await read();
      return versionView(await save({ ...state, check: { ...state.check, enabled } }));
    },

    start(version) {
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
          opts.startGateway();
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
  const entry: UpgradeHistoryEntry = {
    from: pending.from,
    to: pending.to,
    startedAt: pending.startedAt,
    finishedAt: new Date().toISOString(),
    outcome: outcome.ok ? 'done' : 'failed',
    ...(pending.backup === undefined ? {} : { backup: pending.backup }),
    ...(outcome.ok ? {} : { step, error: outcome.error }),
  };
  const state = await readUpgradeState(ctx.data, pending.to);
  await writeUpgradeState(ctx.data, { ...state, current: pending.to, history: [...state.history, entry] });
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
    if (phase === 'upgrade-failed' && last.outcome === 'failed') lines.push(recoverySentence(last));
  }
  return lines;
}
