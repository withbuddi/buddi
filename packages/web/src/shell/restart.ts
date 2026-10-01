/**
 * A restart, watched from the page it happens under.
 *
 * Every way the page restarts buddi — Restart to load it, Restart gateway, an
 * upgrade, a restore, leaving recovery mode — says so here first, and so does
 * a restart the page did not start (the gateway's `closing` frame on the live
 * stream, or a new boot found after the link came back). The shell then draws
 * one full-window "Restarting buddi" (`Restarting.tsx`) over everything, the
 * banners and Reconnecting… defer to it, and this module asks
 * `/_buddi/ready` — the one path the gateway answers before any session, lock
 * or sign-in limit — until the process that answered when the restart began
 * is gone and a new one answers. Then the page reloads: whatever it held was
 * read from the process that is gone, and a reload is the only honest way to
 * drop all of it. The session outlives the restart, and a PIN brings the lock
 * screen, as on any load.
 *
 * "A new one" is a different `boot` in the answer. When the page never learnt
 * the old one, a failed answer followed by any answer stands in for it.
 */
import { isUnreachable } from '../api';
import { somethingInProgress } from './freshness';

export type RestartKind = 'plugins' | 'upgrade' | 'restart' | 'restore' | 'recovery' | 'stop' | 'detected';

export interface RestartAsk {
  kind: RestartKind;
  /** What the restart is for, in one line: "Loading weather 0.1.3 and 4 more…". */
  line?: string;
  /** A smaller line under it: an upgrade's step. */
  step?: string;
  /** How long to wait before saying buddi may need a hand. */
  patienceMs?: number;
}

export interface RestartState extends RestartAsk {
  startedAt: number;
}

/** How long a restart may take before the screen says it is still waiting. */
export const RESTART_PATIENCE_MS = 90_000;
/** An upgrade takes a backup and installs first. */
export const UPGRADE_PATIENCE_MS = 5 * 60_000;
/** The first ask after the restart begins, and the most an ask is put off. */
export const READY_FIRST_MS = 500;
export const READY_MAX_MS = 2_000;
/** A sleeping machine never says no; it just never answers. */
export const READY_TIMEOUT_MS = 3_000;
/** The path that answers before any session (packages/gateway/src/web/server.ts). */
export const READY_PATH = '/_buddi/ready';

/** What the page does at the end; tests replace it. */
export const restartDeps = {
  reload: (): void => window.location.reload(),
  now: (): number => Date.now(),
};

let state: RestartState | null = null;
let knownBoot: string | null = null;
let stopWatch: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: RestartState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

/** The restart being waited for, or null. */
export function restartState(): RestartState | null {
  return state;
}

/** Called whenever a restart begins, changes or is called off. Returns the unsubscribe. */
export function onRestartChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The boot this page last saw answer. */
export function pageBoot(): string | null {
  return knownBoot;
}

/** For tests: no restart, no boot. */
export function resetRestart(): void {
  stopWatch?.();
  stopWatch = null;
  state = null;
  knownBoot = null;
  for (const listener of listeners) listener();
}

function challenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Ask which process answers. A boot id; '' for a gateway that answers without
 * one (older than this page); null when nothing answered.
 */
export async function askReady(timeoutMs = READY_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${READY_PATH}?challenge=${challenge()}`, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (res.status !== 200) return null;
    const body = (await res.json().catch(() => null)) as { boot?: unknown } | null;
    return typeof body?.boot === 'string' ? body.boot : '';
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Learn which process serves this page, once it has loaded. */
export async function learnBoot(): Promise<void> {
  const boot = await askReady();
  if (boot) knownBoot = boot;
}

/** Ask until the old process is gone and a new one answers, then reload. */
function watch(): () => void {
  const old = knownBoot;
  let stopped = false;
  let sawGone = false;
  let delay = READY_FIRST_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const boot = await askReady();
    if (stopped) return;
    if (boot === null) sawGone = true;
    else if (old !== null ? boot !== old : sawGone) {
      stopped = true;
      restartDeps.reload();
      return;
    }
    delay = Math.min(Math.round(delay * 1.5), READY_MAX_MS);
    timer = setTimeout(() => void tick(), delay);
  };
  timer = setTimeout(() => void tick(), delay);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * The page is restarting buddi, or found it restarting. Shown at once; a
 * second begin while one is up only adds what it knows.
 */
export function beginRestart(ask: RestartAsk): void {
  if (state) {
    // A restart the page started knows more than the frame announcing it.
    if (ask.kind === 'detected') return;
    set({ ...state, ...ask });
    return;
  }
  set({ ...ask, startedAt: restartDeps.now() });
  stopWatch = watch();
}

/** A new line or step while it waits (an upgrade's progress). */
export function updateRestart(next: Partial<RestartAsk>): void {
  if (state) set({ ...state, ...next });
}

/** It is not happening after all: the refusal is the page's to show. */
export function cancelRestart(): void {
  stopWatch?.();
  stopWatch = null;
  set(null);
}

/**
 * Begin, then do what restarts buddi. A refusal calls it off and is thrown
 * for the caller to show; no answer at all is the restart under way.
 */
export async function restartWhile<T>(ask: RestartAsk, act: () => Promise<T>): Promise<T | undefined> {
  beginRestart(ask);
  try {
    return await act();
  } catch (error) {
    if (isUnreachable(error)) return undefined;
    cancelRestart();
    throw error;
  }
}

/** The gateway said on the live stream that it is about to close. */
export function noticeClosing(data: Record<string, unknown>): void {
  beginRestart({ kind: data.for === 'stop' ? 'stop' : 'detected' });
}

/**
 * The link came back, or the live stream did: if another process answers now,
 * buddi restarted while this page was not looking. Reloaded the same way —
 * unless something on the page would be lost, which a stale page is not worth.
 */
export async function checkForRestart(): Promise<void> {
  if (state || knownBoot === null) return;
  const boot = await askReady();
  if (!boot || boot === knownBoot || state) return;
  if (somethingInProgress()) {
    knownBoot = boot;
    return;
  }
  beginRestart({ kind: 'detected' });
}

/** "weather 0.1.3", "weather 0.1.3 and mail 0.2.0", "weather 0.1.3 and 4 more". */
export function pluginWords(plugins: Array<{ name: string; version: string }>): string | null {
  const [first, second] = plugins;
  if (!first) return null;
  const one = `${first.name} ${first.version}`;
  if (!second) return one;
  if (plugins.length === 2) return `${one} and ${second.name} ${second.version}`;
  return `${one} and ${plugins.length - 1} more`;
}
