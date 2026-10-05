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
 * when the process that wrote it is still alive.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it is there, owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What the running gateway serves, or undefined when no live gateway wrote it. */
export function readPagesState(env: NodeJS.ProcessEnv = process.env): PagesState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pagesStateFile(env), 'utf8')) as Partial<PagesState>;
    if (typeof parsed.pid !== 'number' || !Array.isArray(parsed.plugins) || typeof parsed.at !== 'string') return undefined;
    if (!alive(parsed.pid)) return undefined;
    return { pid: parsed.pid, at: parsed.at, plugins: parsed.plugins.filter((p): p is string => typeof p === 'string') };
  } catch {
    return undefined;
  }
}
