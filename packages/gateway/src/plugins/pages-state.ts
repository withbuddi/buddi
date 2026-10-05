/**
 * Which plugins have pages in the running gateway, written where `buddi
 * doctor` can read it.
 *
 * The doctor runs in its own process: it can import what is installed, but
 * only the gateway knows what it actually registered. A plugin installed while
 * buddi runs (first run's chapter 3, the catalogue) is loaded live or waits for
 * a restart, and "installed" and "its page is in the rail" are two answers the
 * owner needs side by side. So the gateway writes the names whose pages it
 * serves at start and whenever its registry changes; the doctor reads the file
 * when the process that wrote it is still alive, and the file is that process's.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../web/config.js';

export interface PagesState {
  pid: number;
  at: string;
  /** The plugins whose pages `GET /api/pages` lists now, sorted. */
  plugins: string[];
}

export function pagesStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), 'run', 'pages.json');
}

/** The plugin names of every page a registry serves, each once, sorted. */
export function pagePlugins(registry: { pages(): ReadonlyArray<{ plugin: string }> }): string[] {
  return [...new Set(registry.pages().map((p) => p.plugin))].sort();
}

/** Write what this process serves. Never throws: the doctor then says it could not tell. */
export function writePagesState(
  env: NodeJS.ProcessEnv,
  registry: { pages(): ReadonlyArray<{ plugin: string }> },
  now: Date = new Date(),
): void {
  try {
    const file = pagesStateFile(env);
    mkdirSync(path.dirname(file), { recursive: true });
    const state: PagesState = { pid: process.pid, at: now.toISOString(), plugins: pagePlugins(registry) };
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    /* Not worth a start or a log line. */
  }
}

/** A file older than this says nothing about the gateway running now. */
export const PAGES_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the pid is a live process this user owns. EPERM means a process of
 * somebody else's holds the number now — never our gateway, which runs as the
 * owner — so a reused pid is not taken for a live buddi.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** When a process started, from `ps`; undefined when it cannot say. */
export function processStartedAt(pid: number): Date | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const at = out ? new Date(out) : undefined;
    return at && Number.isFinite(at.getTime()) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the running gateway serves, or undefined when no live gateway wrote it.
 *
 * A pid alone is not enough: after a crash and a reboot the number can belong
 * to any process. So the file is believed only when its writer is alive and
 * ours, it is less than a day old, and it was written after that process
 * started — a file from before the process with its pid began is somebody
 * else's leftover.
 */
export function readPagesState(
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: Date; startedAt?: (pid: number) => Date | undefined } = {},
): PagesState | undefined {
  try {
    const file = pagesStateFile(env);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PagesState>;
    if (typeof parsed.pid !== 'number' || !Array.isArray(parsed.plugins) || typeof parsed.at !== 'string') return undefined;
    const now = (options.now ?? new Date()).getTime();
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at)) return undefined;
    if (now - at > PAGES_STATE_MAX_AGE_MS || now - statSync(file).mtimeMs > PAGES_STATE_MAX_AGE_MS) return undefined;
    if (!alive(parsed.pid)) return undefined;
    const started = (options.startedAt ?? processStartedAt)(parsed.pid);
    // `ps` says when to the second; a file written in the same second counts.
    if (started && at < started.getTime() - 1_000) return undefined;
    return { pid: parsed.pid, at: parsed.at, plugins: parsed.plugins.filter((p): p is string => typeof p === 'string') };
  } catch {
    return undefined;
  }
}
