/**
 * The dashboard's version and upgrade routes.
 *
 * Two worlds again, as with `backups.ts`. In a packaged installation the
 * supervisor owns the whole of it — it is the process that can stop the
 * gateway, run `npm install -g` and re-execute itself afterwards — so every
 * verb here is forwarded down the control socket and nothing in this file
 * fetches, installs or restarts anything. In a developer checkout there is no
 * supervisor and no upgrade to offer: the version is reported (the workspace's
 * own, plus `git describe` when a checkout still has its `.git`) and the page
 * is told to run `git pull` in a terminal instead.
 *
 * `<data>/upgrade.json` is read directly from disk as a fallback, for the one
 * moment the socket cannot answer: an upgrade takes the supervisor down and
 * brings a new one up, and the record of what happened has to outlive both the
 * gateway that asked for it and the supervisor that ran it.
 *
 * Nothing here decides authorization: these routes sit behind the same session,
 * Origin and CSRF gate as every other write in `server.ts`, and the socket on
 * the far side is owner-only already.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { compareVersions } from '@buddi/core';
import { supervisorSocket, type RouteReply } from './backups.js';
import { supervisorCall, type SupervisorReply } from './service.js';

/**
 * What a version has to look like before this route will pass it on.
 *
 * The same shape the supervisor enforces (`VERSION_PATTERN`, upgrade.ts),
 * repeated here so that a range, a tag, a URL or an npm alias is refused by
 * the first thing that sees it rather than by the last.
 */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** What a checkout is told instead of an upgrade button. */
export const CHECKOUT_LINE = 'A checkout upgrades with git pull, then buddi upgrade in a terminal.';

/** One attempt, as `<data>/upgrade.json` keeps it. The supervisor writes it. */
export interface UpgradeAttempt {
  from: string;
  to: string;
  startedAt: string;
  finishedAt?: string;
  outcome: 'done' | 'failed' | 'rolled-back';
  backup?: string;
  error?: string;
  step?: string;
}

/** The file itself, as the supervisor, the CLI and this module all read it. */
export interface UpgradeFile {
  check: { enabled: boolean; lastAt?: string; latest?: string; error?: string };
  current: string;
  registry?: string;
  history: UpgradeAttempt[];
}

export interface VersionDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/* ------------------------------------------------------------------ *
 * This build's own version
 * ------------------------------------------------------------------ */

const require_ = createRequire(import.meta.url);

/** `@buddi/core`'s package.json, which is the workspace's version of record. */
function corePackage(): { version?: string; dir: string } {
  let file: string;
  // Resolution itself can throw, which is not a reason for a page to fail.
  try { file = require_.resolve('@buddi/core/package.json'); }
  catch { return { dir: process.cwd() }; }
  try {
    return { ...(JSON.parse(readFileSync(file, 'utf8')) as { version?: string }), dir: path.dirname(file) };
  } catch {
    return { dir: path.dirname(file) };
  }
}

/**
 * `git describe`, once per process.
 *
 * A checkout's commit does not change under a running gateway, and `--dirty`
 * changing is not worth a subprocess on every page load. The command is only
 * run at all when there is a `.git` beside the workspace root, so a packaged
 * installation — where `@buddi/core` sits in `node_modules` — never spawns it.
 */
let described: Promise<string | null> | undefined;

function describe(workspaceRoot: string): Promise<string | null> {
  described ??= new Promise<string | null>((resolve) => {
    if (!existsSync(path.join(workspaceRoot, '.git'))) return resolve(null);
    execFile('git', ['describe', '--always', '--dirty'], { cwd: workspaceRoot, timeout: 5_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
  return described;
}

/**
 * What this gateway is running, said the way a person would.
 *
 * `0.1.0 (v0.1.0-3-gabc1234-dirty)` in a checkout, `0.1.0` everywhere else.
 * Never throws: a version is a label on a page, and no page is worth failing
 * because `git` is missing.
 */
export async function currentVersion(): Promise<string> {
  try {
    const core = corePackage();
    const version = core.version ?? '0.0.0';
    // `<repo>/packages/core` in a checkout; anywhere else the `.git` test fails.
    const workspaceRoot = path.resolve(core.dir, '..', '..');
    const described = await describe(workspaceRoot);
    return described ? `${version} (${described})` : version;
  } catch {
    return '0.0.0';
  }
}

/* ------------------------------------------------------------------ *
 * The file on disk
 * ------------------------------------------------------------------ */

export function upgradeFilePath(env: NodeJS.ProcessEnv): string | undefined {
  const data = env.BUDDI_DATA_DIR?.trim();
  return data ? path.join(data, 'upgrade.json') : undefined;
}

/** The record as the supervisor left it, or undefined when there is none. */
export async function readUpgradeFile(env: NodeJS.ProcessEnv): Promise<UpgradeFile | undefined> {
  const file = upgradeFilePath(env);
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<UpgradeFile>;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return {
      // `enabled` defaults the way the supervisor defaults it: the daily check
      // is on unless it was turned off, and a file written before the field
      // existed must not read as "off" on one side and "on" on the other.
      check: { ...(parsed.check ?? {}), enabled: parsed.check?.enabled !== false },
      current: typeof parsed.current === 'string' ? parsed.current : '',
      ...(typeof parsed.registry === 'string' ? { registry: parsed.registry } : {}),
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    // No file yet, or one being rewritten. Neither is news for a page.
    return undefined;
  }
}

/** The view a `/version` body has, composed from the file rather than the socket. */
function fromFile(file: UpgradeFile): Record<string, unknown> {
  const latest = file.check.latest;
  return {
    current: file.current,
    ...(latest === undefined ? {} : { latest }),
    ...(file.check.lastAt === undefined ? {} : { checkedAt: file.check.lastAt }),
    checkEnabled: file.check.enabled,
    // The same comparison the supervisor makes (`@buddi/core`'s semver), so
    // that the fallback cannot offer an upgrade the supervisor would not.
    updateAvailable: latest !== undefined && (compareVersions(latest, file.current) ?? 0) > 0,
    ...(file.check.error === undefined ? {} : { error: file.check.error }),
    history: file.history,
  };
}

/* ------------------------------------------------------------------ *
 * Forwarding
 * ------------------------------------------------------------------ */

/**
 * One forwarded call.
 *
 * An upgrade is a long call on the far side — a backup, then an install — so
 * the timeout is the backup route's rather than the status route's.
 */
async function forward(socket: string, route: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<RouteReply | null> {
  let reply: SupervisorReply;
  try {
    reply = await supervisorCall(socket, route, method, body, 120_000);
  } catch {
    return null;
  }
  return { status: reply.status, body: reply.body };
}

const NO_SUPERVISOR = 'The supervisor is not answering on its control socket. Run buddi in a terminal.';

/** The supervisor's answer, dressed with the two facts the page needs. */
function dressed(reply: RouteReply): RouteReply {
  if (reply.status !== 200 || typeof reply.body !== 'object' || reply.body === null) return reply;
  return { status: 200, body: { ...(reply.body as object), supervised: true, checkout: false } };
}

/* ------------------------------------------------------------------ *
 * The routes
 * ------------------------------------------------------------------ */

/**
 * What is running, what is newest, and what upgrading has done before.
 *
 * Supervised, this is the supervisor's answer. Unsupervised, it is a checkout:
 * one version, no check, no history, and the line saying what to run instead.
 */
export async function versionRoute(deps: VersionDeps): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) {
    return {
      status: 200,
      body: {
        current: await currentVersion(),
        checkEnabled: false,
        updateAvailable: false,
        history: [],
        supervised: false,
        checkout: true,
      },
    };
  }
  const reply = await forward(socket, '/version', 'GET');
  if (reply) return dressed(reply);
  // The socket is gone, which during an upgrade is the normal middle of one.
  // What the last supervisor wrote down is a better answer than an error.
  const file = await readUpgradeFile(deps.env);
  if (!file) return { status: 503, body: { error: NO_SUPERVISOR } };
  return { status: 200, body: { ...fromFile(file), supervised: true, checkout: false } };
}

/** Ask the registry now, or turn the daily question on and off. */
export async function versionCheckRoute(
  deps: VersionDeps,
  method: 'POST' | 'PUT',
  body?: Record<string, unknown>,
): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 409, body: { error: CHECKOUT_LINE } };
  if (method === 'PUT' && typeof body?.enabled !== 'boolean') {
    return { status: 400, body: { error: '"enabled" must be true or false.' } };
  }
  const reply = await forward(socket, '/version/check', method, method === 'PUT' ? { enabled: body?.enabled } : undefined);
  return reply ? dressed(reply) : { status: 503, body: { error: NO_SUPERVISOR } };
}

/**
 * Start an upgrade.
 *
 * The answer is `202` and a job; the page follows it until the gateway stops
 * answering, which is the upgrade doing what it said it would.
 */
export async function upgradeRoute(deps: VersionDeps, body: Record<string, unknown>): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 409, body: { error: CHECKOUT_LINE } };
  if (body.version !== undefined && (typeof body.version !== 'string' || !VERSION.test(body.version))) {
    return { status: 400, body: { error: '"version" must be a version like 1.2.3.' } };
  }
  const reply = await forward(socket, '/upgrade', 'POST', body.version === undefined ? {} : { version: body.version });
  return reply ?? { status: 503, body: { error: NO_SUPERVISOR } };
}

/**
 * Where an upgrade has got to, for as long as this gateway is up to say.
 *
 * The supervisor keeps one job route for backups and upgrades alike, so an id
 * handed out by `/upgrade` is polled at `/jobs/<id>` there; the dashboard keeps
 * the two apart in its own URLs because the page follows them differently.
 */
export async function upgradeJobRoute(deps: VersionDeps, id: string): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 409, body: { error: CHECKOUT_LINE } };
  const reply = await forward(socket, `/jobs/${encodeURIComponent(id)}`, 'GET');
  return reply ?? { status: 503, body: { error: NO_SUPERVISOR } };
}
