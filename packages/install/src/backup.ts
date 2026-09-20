/**
 * Backups, as the packaged installation runs them.
 *
 * The engine is `@buddi/core`'s (`src/backup/`) and none of it is repeated
 * here. What is here is everything the engine deliberately does not know:
 *
 *  - **where this installation is.** The engine takes every path in its
 *    options; `installationBackupOptions` is the supervisor's answer, built
 *    from the `ReadyContext` exactly as `packages/cli/src/backup/options.ts`
 *    builds the checkout's from `paths.ts`.
 *  - **that the gateway is a process.** A restore replaces the database the
 *    gateway is holding open, so the gateway is stopped first and started
 *    again afterwards — on the restored database if it worked, on the
 *    rolled-back one if it did not.
 *  - **that a caller is on the far side of a socket.** A backup takes minutes,
 *    so every verb answers immediately with a job id and the work goes on in
 *    the background. Jobs are in memory, last twenty; a supervisor restart
 *    forgets them, which is correct — the archives on disk are the state.
 *  - **the clock.** A scheduled backup is a timer in the supervisor rather
 *    than a launchd unit, because the supervisor is the process that is
 *    already always running and already owns the database.
 *
 * `@buddi/core` and `@buddi/gateway` arrive as arguments rather than value
 * imports, for the reason given in `postgres.ts`: this module is loaded before
 * `environment()` has finished rewriting the environment whose path constants
 * those packages read at import time. Types are imported statically; they are
 * erased.
 */
import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BackupManifest,
  CreateOptions,
  RecoveryPending,
  RestoreOptions,
  RestoreReport,
  VerifyResult,
} from '@buddi/core';
import { atomicJson } from './environment.js';
import type { ReadyContext } from './environment.js';

type Core = typeof import('@buddi/core');
type Gateway = typeof import('@buddi/gateway');

/* ------------------------------------------------------------------ *
 * Names and paths a client may say
 * ------------------------------------------------------------------ */

/** The two names this installation ever writes, plain and encrypted. */
const PLAIN = /^(buddi-backup-|pre-restore-)\d{8}-\d{6}\.tar\.gz$/;
const ENCRYPTED = /^(buddi-backup-|pre-restore-)\d{8}-\d{6}\.tar\.gz\.age$/;

/**
 * An archive name, as a client is allowed to send one.
 *
 * Callers never send paths. They send a name out of `GET /backups`, and it is
 * joined to the backups directory here. A separator, a `..`, a leading dot or
 * a name that is not one of ours is refused before it reaches the filesystem:
 * there is no case in which the dashboard needs to name a file the supervisor
 * did not list.
 */
export function isSafeArchiveName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '' || name.length > 200) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('.') || name.includes('..')) return false;
  return PLAIN.test(name) || ENCRYPTED.test(name);
}

/** Where the gateway writes an uploaded archive, and the only path a client may name. */
export function incomingDir(data: string): string {
  return path.join(data, 'incoming');
}

/** An upload older than this at supervisor start was never restored from. */
export const INCOMING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Forget uploads nobody restored from.
 *
 * An archive is gigabytes and lands here before the owner has typed the
 * confirmation, so an abandoned restore leaves the whole of last night's
 * database in a directory nothing else ever reads. A restore removes its own
 * input (see `runRestore`); this is the sweep for the ones that never ran.
 */
export async function sweepIncoming(
  data: string,
  olderThanMs = INCOMING_MAX_AGE_MS,
  now = Date.now(),
): Promise<string[]> {
  const dir = incomingDir(data);
  if (!existsSync(dir)) return [];
  const gone: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (now - info.mtimeMs < olderThanMs) continue;
    await rm(file, { force: true }).catch(() => {});
    gone.push(name);
  }
  return gone;
}

/**
 * Is `candidate` a file inside `<data>/incoming/`?
 *
 * Resolved and compared as a prefix *with* the separator, so `/incoming-evil`
 * is not `/incoming`. A symlink is not chased: the gateway wrote the file, and
 * a link at that path is somebody else pointing the supervisor elsewhere.
 */
export function isIncomingPath(data: string, candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || candidate === '') return false;
  const root = path.resolve(incomingDir(data));
  const abs = path.resolve(candidate);
  return abs.startsWith(`${root}${path.sep}`) && !abs.slice(root.length + 1).includes('..');
}

/* ------------------------------------------------------------------ *
 * The archive listing
 * ------------------------------------------------------------------ */

export interface ListedBackup {
  name: string;
  createdAt: string;
  bytes: number;
  encrypted: boolean;
  /** For an encrypted archive: does it still match the envelope beside it? */
  envelopeOk: boolean | null;
}

/** The instant in `buddi-backup-YYYYMMDD-HHMMSS…`, in local time. */
export function stampedAt(name: string): number | null {
  const found = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!found) return null;
  const [, y, mo, d, h, mi, s] = found as unknown as string[];
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(at.getTime()) ? null : at.getTime();
}

/**
 * What is in the backups directory, newest first.
 *
 * Core's `listArchives` is not used: it lists the backups an installation
 * took, and this list is the dashboard's, which also has to show the
 * pre-restore copies a restore leaves behind and to say which encrypted
 * archives still match the envelope written beside them. Both of those are
 * this page's business rather than the engine's.
 */
export async function listBackups(dir: string, core: Core): Promise<ListedBackup[]> {
  if (!existsSync(dir)) return [];
  const out: ListedBackup[] = [];
  for (const name of await readdir(dir)) {
    const encrypted = ENCRYPTED.test(name);
    if (!encrypted && !PLAIN.test(name)) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) continue;
    const named = stampedAt(name);
    out.push({
      name,
      createdAt: new Date(named ?? info.mtimeMs).toISOString(),
      bytes: info.size,
      encrypted,
      envelopeOk: encrypted ? (await core.verifyEnvelope(file)).ok : null,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/**
 * Keep the newest `keep` archives and remove the rest, envelope and all.
 *
 * Again not core's `pruneArchives`, and for the same reason as the listing.
 * Pre-restore snapshots are left alone — they are the copy taken of what the
 * owner was about to replace, and a schedule must never be what deletes one.
 */
export async function pruneBackups(dir: string, keep: number, core: Core): Promise<string[]> {
  const listed = (await listBackups(dir, core)).filter((a) => a.name.startsWith('buddi-backup-'));
  const removed: string[] = [];
  for (const entry of listed.slice(Math.max(1, keep))) {
    await rm(path.join(dir, entry.name), { force: true });
    if (entry.encrypted) await rm(core.envelopePath(path.join(dir, entry.name)), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * The schedule
 * ------------------------------------------------------------------ */

export interface BackupSchedule {
  enabled: boolean;
  /** `HH:MM`, local time. */
  time: string;
  keep: number;
  encryptLocal: boolean;
  /** A second copy of every archive, for the folder tier. `null` means none. */
  copyTo: string | null;
}

export interface ScheduleFile extends BackupSchedule {
  /** ISO 8601; what stops two backups on the same day. */
  lastRunAt: string | null;
}

export const DEFAULT_SCHEDULE: ScheduleFile = {
  enabled: false,
  time: '03:30',
  keep: 14,
  encryptLocal: true,
  copyTo: null,
  lastRunAt: null,
};

export function scheduleFile(data: string): string {
  return path.join(data, 'backup.json');
}

/**
 * Parse and validate a schedule a client sent. Plain words on refusal: this
 * message is shown to the owner under the field they just filled in.
 */
export function parseSchedule(body: unknown): { schedule: BackupSchedule } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Expected a schedule object.' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { error: '"enabled" must be true or false.' };
  if (typeof b.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) {
    return { error: 'The time has to look like 03:30, on a 24 hour clock.' };
  }
  if (!Number.isInteger(b.keep) || (b.keep as number) < 1 || (b.keep as number) > 365) {
    return { error: 'Keep a whole number of backups, between 1 and 365.' };
  }
  if (typeof b.encryptLocal !== 'boolean') return { error: '"encryptLocal" must be true or false.' };
  if (b.copyTo !== null && (typeof b.copyTo !== 'string' || !path.isAbsolute(b.copyTo))) {
    return { error: 'The folder to copy to has to be a full path, or left empty.' };
  }
  return {
    schedule: {
      enabled: b.enabled,
      time: b.time,
      keep: b.keep as number,
      encryptLocal: b.encryptLocal,
      copyTo: b.copyTo === null ? null : (b.copyTo as string).trim() || null,
    },
  };
}

/** Is the folder the owner named one we can actually copy into? */
export async function checkCopyTo(dir: string | null): Promise<string | null> {
  if (dir === null) return null;
  let info;
  try {
    info = await stat(dir);
  } catch {
    return `There is nothing at ${dir}. Make the folder first, or pick another one.`;
  }
  if (!info.isDirectory()) return `${dir} is a file, not a folder.`;
  try {
    await access(dir, constants.W_OK);
  } catch {
    return `buddi cannot write into ${dir}. Check who owns it.`;
  }
  return null;
}

export async function readSchedule(data: string): Promise<ScheduleFile> {
  try {
    const raw = JSON.parse(await readFile(scheduleFile(data), 'utf8')) as Partial<ScheduleFile>;
    const parsed = parseSchedule({
      enabled: raw.enabled ?? DEFAULT_SCHEDULE.enabled,
      time: raw.time ?? DEFAULT_SCHEDULE.time,
      keep: raw.keep ?? DEFAULT_SCHEDULE.keep,
      encryptLocal: raw.encryptLocal ?? DEFAULT_SCHEDULE.encryptLocal,
      copyTo: raw.copyTo ?? null,
    });
    if ('error' in parsed) return { ...DEFAULT_SCHEDULE };
    return {
      ...parsed.schedule,
      lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export async function writeSchedule(data: string, file: ScheduleFile): Promise<void> {
  await atomicJson(scheduleFile(data), file);
  await chmod(scheduleFile(data), 0o600).catch(() => {});
}

/**
 * Has the local clock crossed today's time without a backup having run?
 *
 * "Today" is the local calendar day, so a laptop that was asleep at 03:30 takes
 * its backup the moment it wakes — the behaviour a calendar job has and an
 * interval job does not.
 */
export function backupDue(file: ScheduleFile, now: Date): boolean {
  if (!file.enabled) return false;
  const [hh, mm] = file.time.split(':').map(Number) as [number, number];
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (now.getTime() < at.getTime()) return false;
  if (file.lastRunAt === null) return true;
  const last = new Date(file.lastRunAt);
  return Number.isNaN(last.getTime()) ? true : last.getTime() < at.getTime();
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export type JobKind = 'backup' | 'verify' | 'restore';

export interface BackupJob {
  id: string;
  kind: JobKind;
  phase: string;
  /** Every phase this job has been in, in order. */
  phases: string[];
  detail?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** Whatever the verb produced: an archive name, a verify result, a report. */
  report?: unknown;
  /** The archive was written but the second copy was not. Never a failure. */
  copyLate?: boolean;
}

/** The last twenty jobs, newest last. Memory only: the archives are the state. */
export class JobStore {
  private readonly jobs = new Map<string, BackupJob>();

  constructor(private readonly limit = 20) {}

  start(kind: JobKind): BackupJob {
    const job: BackupJob = {
      id: randomUUID(),
      kind,
      phase: 'starting',
      phases: ['starting'],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > this.limit) {
      const oldest = this.jobs.keys().next();
      if (oldest.done) break;
      this.jobs.delete(oldest.value);
    }
    return job;
  }

  phase(job: BackupJob, phase: string, detail?: string): void {
    job.phase = phase;
    if (job.phases[job.phases.length - 1] !== phase) job.phases.push(phase);
    if (detail === undefined) delete job.detail;
    else job.detail = detail;
  }

  finish(job: BackupJob, phase: string, extra: Partial<BackupJob> = {}): void {
    this.phase(job, phase);
    job.finishedAt = new Date().toISOString();
    Object.assign(job, extra);
  }

  get(id: string): BackupJob | undefined {
    return this.jobs.get(id);
  }

  list(): BackupJob[] {
    return [...this.jobs.values()];
  }
}

/* ------------------------------------------------------------------ *
 * The engine's options, for this installation
 * ------------------------------------------------------------------ */

/**
 * Everything the engine needs about a packaged installation.
 *
 * The same shape `packages/cli/src/backup/options.ts` builds for a checkout,
 * answered from the `ReadyContext` instead of from `paths.ts` — which is the
 * whole reason the engine takes paths rather than finding them.
 */
export function installationBackupOptions(
  ctx: ReadyContext,
  core: Core,
  gateway: Gateway,
): CreateOptions {
  const env = ctx.env;
  const search = gateway.agentSearchPath(env);
  const migrationDirs = [{ schema: core.CORE_SCHEMA, dir: core.CORE_MIGRATIONS_DIR }];
  const plugins: NonNullable<CreateOptions['plugins']>[number][] = [];
  for (const manifest of gateway.installedManifests(env)) {
    if ((manifest.migrationsDir ?? '').trim() !== '') {
      migrationDirs.push({ schema: manifest.schema, dir: manifest.migrationsDir });
    }
  }
  const pluginsFile = core.pluginsFilePath({ ownerRoot: search.ownerRoot, env });
  try {
    for (const p of core.readPluginsFile(pluginsFile).plugins) {
      plugins.push({ name: p.name, version: p.version, schema: p.schema, source: p.source.path });
    }
  } catch {
    // An unreadable record is `buddi plugins`' problem, not a reason to refuse
    // a backup of everything else.
  }
  return {
    databaseUrl: env.DATABASE_URL as string,
    backupsDir: path.join(ctx.data, 'backups'),
    dataDir: ctx.data,
    agentsDir: search.owner.dir,
    skillsDir: search.owner.skillsDir,
    pluginsFile,
    envFile: env.BUDDI_ENV_FILE ?? path.join(ctx.data, '.env'),
    timezone: core.timezoneFromEnv(env),
    migrationDirs,
    plugins,
    vault: core.createVault({ env }),
  };
}

/** The migrations each installed plugin ships, so a restore can rebuild it. */
export function installationPluginMigrations(
  ctx: ReadyContext,
  gateway: Gateway,
): NonNullable<RestoreOptions['pluginMigrations']> {
  return gateway
    .installedManifests(ctx.env)
    .filter((m) => (m.migrationsDir ?? '').trim() !== '')
    .map((m) => ({ schema: m.schema, dir: m.migrationsDir, plugin: m.name }));
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

/** What the control socket can ask for. Every verb answers at once. */
export interface BackupControl {
  dir: string;
  list(): Promise<{ dir: string; database: string; archives: ListedBackup[] }>;
  create(encrypt: boolean | undefined): BackupJob | { status: number; error: string };
  verify(name: string): BackupJob;
  restore(input: RestoreRequest): Promise<BackupJob | { status: number; error: string }>;
  job(id: string): BackupJob | undefined;
  schedule(): Promise<ScheduleFile>;
  setSchedule(next: BackupSchedule): Promise<{ error: string } | { schedule: ScheduleFile }>;
  passphrase(): Promise<string>;
  setPassphrase(value: string): Promise<void>;
  lastBackupAt(): Promise<string | null>;
  /** Is the installation still in recovery? Reported by `/status`. */
  inRecovery(): Promise<boolean>;
  /**
   * Is a restore running?
   *
   * A restore stops the gateway, replaces the database under it and starts it
   * again. Anything else that stops, starts or writes to that database in the
   * meantime is a second hand on the same lever, so the socket refuses it
   * while this is true rather than queueing it behind a job that may well
   * roll the database back.
   */
  busy(): boolean;
  /** One minute has passed: run the scheduled backup if it is due. */
  tick(now?: Date): Promise<void>;
}

export interface RestoreRequest {
  /** A name out of the listing, or a path under `<data>/incoming/`. Not both. */
  name?: string | undefined;
  path?: string | undefined;
  passphrase?: string | undefined;
  confirm?: string | undefined;
}

export interface BackupServiceOptions {
  ctx: ReadyContext;
  core: Core;
  gateway: Gateway;
  /** Stop the gateway child, keeping the database up. */
  stopGateway: () => Promise<void>;
  /** Start it again. */
  startGateway: () => void;
  log?: ((line: string) => void) | undefined;
}

export function createBackupService(opts: BackupServiceOptions): BackupControl {
  const { ctx, core, gateway } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const jobs = new JobStore();
  const dir = path.join(ctx.data, 'backups');
  const databaseUrl = ctx.env.DATABASE_URL as string;

  /** One at a time. A second backup while one runs would dump the same rows twice. */
  let chain: Promise<void> = Promise.resolve();
  const queue = (work: () => Promise<void>): void => {
    chain = chain.catch(() => {}).then(work);
  };

  /**
   * The restore that is under way, if there is one.
   *
   * Held from the moment the job is accepted until the job has an outcome, and
   * read by everything that would otherwise act on the same database or the
   * same gateway process while it is being replaced. See `busy` above.
   */
  let restoring: BackupJob | undefined;
  const RESTORE_RUNNING = 'A restore is running.';

  const vault = (): ReturnType<Core['createVault']> => core.createVault({ env: ctx.env });

  const passphrase = async (): Promise<string> => {
    const v = vault();
    if (!v) throw new Error('This installation has no vault, so a passphrase cannot be kept.');
    const existing = await v.get(core.BACKUP_PASSPHRASE_KEY);
    if (existing !== null && existing.trim() !== '') return core.normalizePassphrase(existing);
    const made = core.generatePassphrase();
    await v.set(core.BACKUP_PASSPHRASE_KEY, made);
    return made;
  };

  /** Copy an archive (and its envelope) into the owner's second folder. */
  const copyOut = async (archive: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(archive, path.join(to, path.basename(archive)));
    const envelope = core.envelopePath(archive);
    if (archive.endsWith('.age') && existsSync(envelope)) {
      await copyFile(envelope, path.join(to, path.basename(envelope)));
    }
  };

  /**
   * One backup, start to finish: dump, encrypt, prune, copy.
   *
   * The gateway keeps running throughout. The dump is one repeatable-read
   * snapshot, so what lands in the archive is the database as it was when the
   * dump began, whatever the gateway writes while it runs.
   */
  const runBackup = async (job: BackupJob, encrypt: boolean): Promise<void> => {
    const schedule = await readSchedule(ctx.data);
    const options = installationBackupOptions(ctx, core, gateway);
    const result = await core.createBackup({
      ...options,
      onProgress: (step) => jobs.phase(job, step.phase, step.detail),
    });
    let archive = result.archive;
    if (encrypt) {
      jobs.phase(job, 'encrypt', 'locking the archive with your passphrase');
      const secret = await passphrase();
      const target = `${result.archive}.age`;
      await core.encryptFile(result.archive, target, secret);
      await core.writeEnvelope(target);
      await rm(result.archive, { force: true });
      archive = target;
    }
    const removed = await pruneBackups(dir, schedule.keep, core);
    let copyLate: boolean | undefined;
    if (schedule.copyTo !== null) {
      try {
        await copyOut(archive, schedule.copyTo);
      } catch (err) {
        // A folder that was not there is a copy that did not happen, never a
        // backup that failed: the archive beside the installation is real.
        copyLate = true;
        log(`backup: the copy to ${schedule.copyTo} did not happen: ${message(err)}`);
      }
    }
    jobs.finish(job, 'done', {
      report: {
        archive: path.basename(archive),
        bytes: (await stat(archive)).size,
        encrypted: encrypt,
        pruned: removed,
        manifest: summarize(result.manifest),
      },
      ...(copyLate ? { copyLate } : {}),
    });
  };

  const runVerify = async (job: BackupJob, name: string): Promise<void> => {
    const archive = path.join(dir, name);
    const result: VerifyResult = await core.verifyBackup({
      archive,
      ...(archive.endsWith('.age') ? { passphrase: await passphrase() } : {}),
      onProgress: (step) => jobs.phase(job, step.phase, step.detail),
    });
    jobs.finish(job, result.ok ? 'done' : 'failed', {
      report: { ok: result.ok, checks: result.checks, problems: result.problems },
      ...(result.ok ? {} : { error: result.problems.join('; ') }),
    });
  };

  /**
   * The archive a restore was given, when it was an upload.
   *
   * An upload is a copy of a whole installation sitting in a directory nothing
   * else reads. Once the restore has an outcome the copy has served its
   * purpose, so it goes — except when the rollback itself failed, where the
   * file is the only way back and the job says where it is.
   */
  const clearIncoming = async (archive: string): Promise<boolean> => {
    if (!isIncomingPath(ctx.data, archive)) return false;
    await rm(archive, { force: true }).catch(() => {});
    await rm(core.envelopePath(archive), { force: true }).catch(() => {});
    return true;
  };

  /**
   * A restore, with the gateway out of the way.
   *
   * The order is the contract: stop, snapshot, database, files, write the
   * recovery row, start. A failure anywhere up to and including the engine
   * leaves the engine's rollback in place and the gateway started again on it,
   * because a failed restore that also leaves the installation down is two
   * problems.
   *
   * The recovery row is written inside the restore, through the engine's
   * `afterDatabase` hook, because it is what keeps the restored installation's
   * loops off until the owner has been through the checklist: a gateway
   * started without it would run a week-old queue against today's world. A row
   * that cannot be written therefore rolls the whole restore back rather than
   * leaving an installation that is restored and ungated.
   */
  const runRestore = async (job: BackupJob, archive: string, phrase: string | undefined): Promise<void> => {
    jobs.phase(job, 'stopping', 'stopping the gateway');
    await opts.stopGateway();
    let report: RestoreReport | undefined;
    try {
      report = await core.restoreBackup({
        ...installationBackupOptions(ctx, core, gateway),
        archive,
        pluginMigrations: installationPluginMigrations(ctx, gateway),
        yes: true,
        typed: core.databaseIn(databaseUrl),
        force: true,
        ...(phrase === undefined ? {} : { passphrase: phrase }),
        afterDatabase: async (pool) => {
          jobs.phase(job, 'recovery', 'noting what came back');
          const pending: RecoveryPending = await core.countPending(pool);
          await core.enterRecovery(pool, {
            archive: path.basename(archive),
            buddiVersion: report?.manifest?.buddiVersion ?? null,
            pending,
          });
        },
        onProgress: (step) => jobs.phase(job, step.phase, step.detail),
      });
      if (!report.ok) throw new Error(report.didNot.join('; ') || 'the restore did not finish');
    } catch (err) {
      // Whatever happened, the installation has to be up again afterwards.
      jobs.phase(job, 'starting', 'starting the gateway again');
      opts.startGateway();
      // `rolledBack` is the engine saying it put the snapshot back. Anything
      // else failed without undoing itself, and must not be reported as if it
      // had: that is the difference between "nothing happened" and "something
      // did, and it is still there".
      const rolledBack = report?.rolledBack === true;
      if (rolledBack) await clearIncoming(archive);
      const stranded = !rolledBack && isIncomingPath(ctx.data, archive);
      jobs.finish(job, rolledBack ? 'rolled-back' : 'failed', {
        error: stranded
          ? `${message(err)}. The file you uploaded is still at ${archive}.`
          : message(err),
        ...(report ? { report: summarizeRestore(report) } : {}),
      });
      return;
    }

    jobs.phase(job, 'starting', 'starting the gateway again');
    opts.startGateway();
    await clearIncoming(archive);
    jobs.finish(job, 'done', { report: summarizeRestore(report) });
  };

  /** Does this database hold work the owner would be sorry to lose? */
  const needsConfirm = async (): Promise<boolean> => {
    const pool = core.createPool(databaseUrl);
    try {
      const { rows } = await pool.query<{ n: string }>(
        `select (
           (select count(*) from core.conversations) +
           (select count(*) from core.messages)
         )::text as n`,
      );
      return Number(rows[0]?.n ?? '0') > 0;
    } catch {
      // No schema at all is an empty installation, which needs no confirmation.
      return false;
    } finally {
      await pool.end().catch(() => {});
    }
  };

  return {
    dir,

    async list() {
      // The database name travels with the listing because it is the word the
      // typed-back confirmation asks the owner to type.
      return { dir, database: core.databaseIn(databaseUrl), archives: await listBackups(dir, core) };
    },

    create(encrypt) {
      if (restoring) return { status: 409, error: RESTORE_RUNNING };
      const job = jobs.start('backup');
      queue(async () => {
        try {
          await runBackup(job, encrypt !== false);
        } catch (err) {
          jobs.finish(job, 'failed', { error: message(err) });
        }
      });
      return job;
    },

    verify(name) {
      const job = jobs.start('verify');
      queue(async () => {
        try {
          await runVerify(job, name);
        } catch (err) {
          jobs.finish(job, 'failed', { error: message(err) });
        }
      });
      return job;
    },

    async restore(input) {
      if (restoring) return { status: 409, error: RESTORE_RUNNING };
      const archive =
        input.path !== undefined ? path.resolve(input.path) : path.join(dir, input.name as string);
      if (!existsSync(archive)) return { status: 404, error: 'There is no such backup.' };
      if (archive.endsWith('.age') && (input.passphrase ?? '').trim() === '') {
        return { status: 400, error: 'This backup is locked. Its passphrase opens it.' };
      }
      const database = core.databaseIn(databaseUrl);
      if (await needsConfirm()) {
        if ((input.confirm ?? '').trim() !== database) {
          return {
            status: 400,
            error: `This replaces everything in "${database}". Type ${database} to confirm.`,
          };
        }
      }
      const job = jobs.start('restore');
      restoring = job;
      queue(async () => {
        try {
          await runRestore(
            job,
            archive,
            input.passphrase === undefined ? undefined : core.normalizePassphrase(input.passphrase),
          );
        } catch (err) {
          jobs.finish(job, 'failed', { error: message(err) });
        } finally {
          restoring = undefined;
        }
      });
      return job;
    },

    job: (id) => jobs.get(id),

    schedule: () => readSchedule(ctx.data),

    async setSchedule(next) {
      const problem = await checkCopyTo(next.copyTo);
      if (problem !== null) return { error: problem };
      const current = await readSchedule(ctx.data);
      const file: ScheduleFile = { ...next, lastRunAt: current.lastRunAt };
      await writeSchedule(ctx.data, file);
      return { schedule: file };
    },

    passphrase,

    async setPassphrase(value) {
      const v = vault();
      if (!v) throw new Error('This installation has no vault, so a passphrase cannot be kept.');
      const normalized = core.normalizePassphrase(value);
      if (normalized === '') throw new Error('A passphrase cannot be empty.');
      await v.set(core.BACKUP_PASSPHRASE_KEY, normalized);
    },

    async lastBackupAt() {
      const archives = (await listBackups(dir, core)).filter((a) =>
        a.name.startsWith('buddi-backup-'),
      );
      return archives[0]?.createdAt ?? null;
    },

    async inRecovery() {
      const pool = core.createPool(databaseUrl);
      try {
        return await core.inRecovery(pool);
      } finally {
        await pool.end().catch(() => {});
      }
    },

    busy: () => restoring !== undefined,

    async tick(now = new Date()) {
      // A scheduled backup of a database that is being replaced would archive
      // whichever half won. `lastRunAt` is left alone, so the backup happens
      // on the next tick after the restore is over.
      if (restoring) return;
      const file = await readSchedule(ctx.data);
      if (!backupDue(file, now)) return;
      // Written before the run, not after: a backup that crashes must not be
      // retried every minute for the rest of the day.
      await writeSchedule(ctx.data, { ...file, lastRunAt: now.toISOString() });
      const job = jobs.start('backup');
      queue(async () => {
        try {
          await runBackup(job, file.encryptLocal);
          log(`backup: the scheduled backup finished (${String(job.phase)})`);
        } catch (err) {
          jobs.finish(job, 'failed', { error: message(err) });
          log(`backup: the scheduled backup failed: ${message(err)}`);
        }
      });
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The manifest, small enough to put in a job report. */
function summarize(manifest: BackupManifest): Record<string, unknown> {
  return {
    createdAt: manifest.createdAt,
    buddiVersion: manifest.buddiVersion,
    tables: manifest.tables.length,
    rows: manifest.tables.reduce((sum, t) => sum + t.rows, 0),
    artifacts: manifest.artifacts.count,
    secrets: manifest.secrets.names,
  };
}

function summarizeRestore(report: RestoreReport): Record<string, unknown> {
  return {
    ok: report.ok,
    did: report.did,
    didNot: report.didNot,
    next: report.next,
    snapshot: report.snapshot === null ? null : path.basename(report.snapshot),
    rolledBack: report.rolledBack,
  };
}
