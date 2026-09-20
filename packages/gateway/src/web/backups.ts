/**
 * The dashboard's backup routes.
 *
 * Two worlds, one API. In a packaged installation every verb is forwarded down
 * the supervisor's control socket, because the supervisor is the process that
 * owns the database and can stop the gateway — which a restore has to do, and
 * which the gateway obviously cannot do to itself. In a developer checkout
 * there is no supervisor at all, so the read-only and additive verbs run here,
 * in this process, against `DATABASE_URL` and `<ownerRoot>/backups`, and
 * restore says plainly that it needs the packaged installation.
 *
 * Nothing in here decides authorization: these routes sit behind the same
 * session, Origin and CSRF gate as every other write in `server.ts`, and the
 * socket on the far side is owner-only already.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_PASSPHRASE_KEY,
  createBackup,
  createVault,
  describeSource,
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  encryptFile,
  envelopePath,
  generatePassphrase,
  normalizePassphrase,
  pluginsFilePath,
  readPluginsFile,
  resolveDataDir,
  timezoneFromEnv,
  verifyBackup,
  verifyEnvelope,
  type CreateOptions,
  type MigrationDir,
  type PluginRecord,
} from '@buddi/core';
import { agentSearchPath, installedManifests } from '../agents/catalog.js';
import { supervisorCall, type SupervisorReply } from './service.js';

/** The largest archive the dashboard will accept as an upload. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

/** A refusal in the shape the router sends. */
export interface RouteReply {
  status: number;
  body: unknown;
}

const RESTORE_NEEDS_INSTALL =
  'Restore needs the packaged installation. In a checkout, run: buddi backup restore <file>';

export function supervisorSocket(env: NodeJS.ProcessEnv): string | undefined {
  const socket = env.BUDDI_SUPERVISOR_SOCKET?.trim();
  return socket === undefined || socket === '' ? undefined : socket;
}

/** One forwarded call, with the two failures the page has to be able to tell apart. */
async function forward(
  socket: string,
  route: string,
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown,
): Promise<RouteReply> {
  let reply: SupervisorReply;
  try {
    reply = await supervisorCall(socket, route, method, body, 120_000);
  } catch {
    return {
      status: 503,
      body: { error: 'The supervisor is not answering on its control socket. Run buddi in a terminal.' },
    };
  }
  return { status: reply.status, body: reply.body };
}

/* ------------------------------------------------------------------ *
 * The checkout's own engine options
 * ------------------------------------------------------------------ */

/**
 * What the engine needs to know about a checkout.
 *
 * The same answer `packages/cli/src/backup/options.ts` gives, assembled from
 * the environment this process was started with rather than from `paths.ts`:
 * the gateway cannot import the CLI, and the engine takes every path in its
 * options precisely so that both callers can answer for themselves.
 */
export function checkoutBackupOptions(env: NodeJS.ProcessEnv): CreateOptions {
  const search = agentSearchPath(env);
  const migrationDirs: MigrationDir[] = [{ schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR }];
  const plugins: PluginRecord[] = [];
  for (const manifest of installedManifests(env)) {
    if ((manifest.migrationsDir ?? '').trim() !== '') {
      migrationDirs.push({ schema: manifest.schema, dir: manifest.migrationsDir });
    }
  }
  const pluginsFile = pluginsFilePath({ ownerRoot: search.ownerRoot, env });
  try {
    for (const p of readPluginsFile(pluginsFile).plugins) {
      plugins.push({ name: p.name, version: p.version, schema: p.schema, source: describeSource(p.source) });
    }
  } catch {
    // An unreadable record is `buddi plugins`' problem, not a backup's.
  }
  return {
    databaseUrl: env.DATABASE_URL as string,
    backupsDir: path.join(search.ownerRoot, 'backups'),
    dataDir: resolveDataDir(env),
    agentsDir: search.owner.dir,
    skillsDir: search.owner.skillsDir,
    pluginsFile,
    envFile: env.BUDDI_ENV_FILE,
    timezone: timezoneFromEnv(env),
    migrationDirs,
    plugins,
    vault: createVault({ env }),
  };
}

/* ------------------------------------------------------------------ *
 * In-process jobs
 * ------------------------------------------------------------------ */

export interface InProcessJob {
  id: string;
  kind: 'backup' | 'verify';
  phase: string;
  phases: string[];
  detail?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  report?: unknown;
}

/** Last twenty, in memory. A checkout restart forgets them; the files remain. */
const JOBS = new Map<string, InProcessJob>();

function startJob(kind: InProcessJob['kind']): InProcessJob {
  const job: InProcessJob = {
    id: randomUUID(),
    kind,
    phase: 'starting',
    phases: ['starting'],
    startedAt: new Date().toISOString(),
  };
  JOBS.set(job.id, job);
  while (JOBS.size > 20) {
    const oldest = JOBS.keys().next();
    if (oldest.done) break;
    JOBS.delete(oldest.value);
  }
  return job;
}

function phase(job: InProcessJob, name: string, detail?: string): void {
  job.phase = name;
  if (job.phases[job.phases.length - 1] !== name) job.phases.push(name);
  if (detail === undefined) delete job.detail;
  else job.detail = detail;
}

function finish(job: InProcessJob, name: string, extra: Partial<InProcessJob>): void {
  phase(job, name);
  job.finishedAt = new Date().toISOString();
  Object.assign(job, extra);
}

const PLAIN = /^(buddi-backup-|pre-restore-)\d{8}-\d{6}\.tar\.gz$/;
const ENCRYPTED = /^(buddi-backup-|pre-restore-)\d{8}-\d{6}\.tar\.gz\.age$/;

/** The same name rule the supervisor applies; a client never sends a path. */
export function isSafeArchiveName(name: unknown): name is string {
  return typeof name === 'string' && (PLAIN.test(name) || ENCRYPTED.test(name));
}

async function listInProcess(dir: string): Promise<RouteReply> {
  if (!existsSync(dir)) return { status: 200, body: { dir, archives: [] } };
  const { readdir } = await import('node:fs/promises');
  const archives = [];
  for (const name of await readdir(dir)) {
    const encrypted = ENCRYPTED.test(name);
    if (!encrypted && !PLAIN.test(name)) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    archives.push({
      name,
      createdAt: new Date(info.mtimeMs).toISOString(),
      bytes: info.size,
      encrypted,
      envelopeOk: encrypted ? (await verifyEnvelope(path.join(dir, name))).ok : null,
    });
  }
  archives.sort((a, b) => b.name.localeCompare(a.name));
  return { status: 200, body: { dir, archives } };
}

/** The passphrase this installation keeps, generating one the first time. */
async function checkoutPassphrase(env: NodeJS.ProcessEnv): Promise<string> {
  const vault = createVault({ env });
  if (!vault) throw new Error('This installation has no vault, so a passphrase cannot be kept.');
  const existing = await vault.get(BACKUP_PASSPHRASE_KEY);
  if (existing !== null && existing.trim() !== '') return normalizePassphrase(existing);
  const made = generatePassphrase();
  await vault.set(BACKUP_PASSPHRASE_KEY, made);
  return made;
}

/* ------------------------------------------------------------------ *
 * The routes
 * ------------------------------------------------------------------ */

export interface BackupsDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/**
 * What this installation has, plus the two facts the restore panel needs: the
 * database name the confirmation asks to be typed, and whether there is a
 * supervisor — which is what decides whether a restore is offered at all.
 */
export async function listBackups(deps: BackupsDeps): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (socket) {
    const out = await forward(socket, '/backups', 'GET');
    return out.status === 200 && typeof out.body === 'object' && out.body !== null
      ? { status: 200, body: { ...(out.body as object), supervised: true } }
      : out;
  }
  const listed = await listInProcess(checkoutBackupOptions(deps.env).backupsDir);
  return {
    status: listed.status,
    body: { ...(listed.body as object), database: databaseName(deps.env), supervised: false },
  };
}

/** The database this installation runs on, by name. Never its credentials. */
function databaseName(env: NodeJS.ProcessEnv): string {
  try {
    return decodeURIComponent(new URL(env.DATABASE_URL as string).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

export async function createBackupRoute(
  deps: BackupsDeps,
  body: Record<string, unknown>,
): Promise<RouteReply> {
  if (body.encrypt !== undefined && typeof body.encrypt !== 'boolean') {
    return { status: 400, body: { error: '"encrypt" must be true or false.' } };
  }
  const socket = supervisorSocket(deps.env);
  if (socket) return forward(socket, '/backup', 'POST', { encrypt: body.encrypt !== false });
  if (!deps.env.DATABASE_URL) {
    return { status: 503, body: { error: 'DATABASE_URL is not set — run `buddi init`.' } };
  }
  const encrypt = body.encrypt === true;
  const job = startJob('backup');
  void (async () => {
    try {
      const options = checkoutBackupOptions(deps.env);
      const result = await createBackup({
        ...options,
        onProgress: (step) => phase(job, step.phase, step.detail),
      });
      let archive = result.archive;
      if (encrypt) {
        phase(job, 'encrypt', 'locking the archive with your passphrase');
        const secret = await checkoutPassphrase(deps.env);
        await encryptFile(result.archive, `${result.archive}.age`, secret);
        const { writeEnvelope } = await import('@buddi/core');
        await writeEnvelope(`${result.archive}.age`);
        await rm(result.archive, { force: true });
        archive = `${result.archive}.age`;
      }
      finish(job, 'done', {
        report: { archive: path.basename(archive), bytes: (await stat(archive)).size, encrypted: encrypt },
      });
    } catch (err) {
      finish(job, 'failed', { error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return { status: 202, body: { job } };
}

export async function verifyBackupRoute(
  deps: BackupsDeps,
  body: Record<string, unknown>,
): Promise<RouteReply> {
  if (!isSafeArchiveName(body.name)) {
    return { status: 400, body: { error: 'That is not the name of a backup.' } };
  }
  const socket = supervisorSocket(deps.env);
  if (socket) return forward(socket, '/verify', 'POST', { name: body.name });
  const dir = checkoutBackupOptions(deps.env).backupsDir;
  const archive = path.join(dir, body.name);
  if (!existsSync(archive)) return { status: 404, body: { error: 'There is no such backup.' } };
  const job = startJob('verify');
  void (async () => {
    try {
      const result = await verifyBackup({
        archive,
        ...(archive.endsWith('.age') ? { passphrase: await checkoutPassphrase(deps.env) } : {}),
        onProgress: (step) => phase(job, step.phase, step.detail),
      });
      finish(job, result.ok ? 'done' : 'failed', {
        report: { ok: result.ok, checks: result.checks, problems: result.problems },
        ...(result.ok ? {} : { error: result.problems.join('; ') }),
      });
    } catch (err) {
      finish(job, 'failed', { error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return { status: 202, body: { job } };
}

export async function backupJobRoute(deps: BackupsDeps, id: string): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (socket) return forward(socket, `/jobs/${encodeURIComponent(id)}`, 'GET');
  const job = JOBS.get(id);
  return job ? { status: 200, body: job } : { status: 404, body: { error: 'no such job' } };
}

export async function scheduleRoute(
  deps: BackupsDeps,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (socket) return forward(socket, '/schedule', method, body);
  // A checkout's schedule is the launchd or systemd unit `buddi backup
  // schedule install` writes. The gateway does not own it and must not
  // pretend to: saying so is more useful than a switch that changes nothing.
  return {
    status: method === 'GET' ? 200 : 409,
    body: {
      supervised: false,
      error: 'A checkout schedules its backups with: buddi backup schedule install',
    },
  };
}

export async function passphraseRoute(
  deps: BackupsDeps,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (socket) return forward(socket, '/passphrase', method, body);
  try {
    if (method === 'GET') return { status: 200, body: { passphrase: await checkoutPassphrase(deps.env) } };
    const given = body?.passphrase;
    if (typeof given !== 'string' || normalizePassphrase(given) === '') {
      return { status: 400, body: { error: 'A passphrase cannot be empty.' } };
    }
    const vault = createVault({ env: deps.env });
    if (!vault) throw new Error('This installation has no vault, so a passphrase cannot be kept.');
    await vault.set(BACKUP_PASSPHRASE_KEY, normalizePassphrase(given));
    return { status: 200, body: { passphrase: normalizePassphrase(given) } };
  } catch (err) {
    return { status: 503, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

/**
 * Restore from an archive this installation already has.
 *
 * Only the supervisor can do this: the database has to be let go of, and the
 * process holding it is this one.
 */
export async function restoreRoute(
  deps: BackupsDeps,
  input: { name?: string | undefined; path?: string | undefined; passphrase?: string | undefined; confirm?: string | undefined },
): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 409, body: { error: RESTORE_NEEDS_INSTALL } };
  if (input.path === undefined && !isSafeArchiveName(input.name)) {
    return { status: 400, body: { error: 'That is not the name of a backup.' } };
  }
  return forward(socket, '/restore', 'POST', {
    ...(input.path === undefined ? { name: input.name } : { path: input.path }),
    ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase }),
    ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
  });
}

/** The filename an upload is stored under: ours, never the browser's. */
export function incomingName(claimed: string | undefined): string {
  const base = path.basename((claimed ?? '').trim());
  const encrypted = base.endsWith('.age');
  return `upload-${Date.now()}-${randomUUID().slice(0, 8)}.tar.gz${encrypted ? '.age' : ''}`;
}

/**
 * Stream an uploaded archive into `<data>/incoming/`, 0600.
 *
 * The browser's own filename is not used — only whether it ended in `.age`,
 * which decides what this installation calls the file it wrote. Nothing the
 * page sends becomes a path.
 */
export async function receiveUpload(
  deps: BackupsDeps,
  req: IncomingMessage,
  claimedName: string | undefined,
): Promise<{ path: string } | RouteReply> {
  const data = deps.env.BUDDI_DATA_DIR?.trim();
  if (!data) return { status: 409, body: { error: RESTORE_NEEDS_INSTALL } };
  const dir = path.join(data, 'incoming');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, incomingName(claimedName));
  let bytes = 0;
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES && !tooBig) {
      tooBig = true;
      req.destroy(new Error('that file is larger than buddi accepts'));
    }
  });
  try {
    await pipeline(req, createWriteStream(target, { mode: 0o600 }));
  } catch (err) {
    await rm(target, { force: true });
    return {
      status: tooBig ? 413 : 400,
      body: { error: tooBig ? 'That file is too large.' : `The upload did not finish: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  if (bytes === 0) {
    await rm(target, { force: true });
    return { status: 400, body: { error: 'That upload was empty.' } };
  }
  return { path: target };
}

/** Delete an upload that was never restored. Best effort, never fatal. */
export async function discardUpload(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => {});
  await rm(envelopePath(file), { force: true }).catch(() => {});
}
