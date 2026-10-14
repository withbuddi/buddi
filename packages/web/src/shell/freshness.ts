/**
 * Knowing about a new dashboard build, and reloading onto it when it is safe.
 *
 * The gateway says which build it serves (`/api/version` → `web`). The shell
 * asks every five minutes and again right after the live stream reconnects —
 * a restart onto a new build drops the stream, so a reconnect is the moment a
 * new build is most likely. When the served build is not this page's:
 *
 *  - the tab is hidden, or the owner has been idle for a minute with every
 *    composer on the page empty, nothing recording and no sheet or dialog
 *    open → reload now, where the owner was (a reload keeps the hash);
 *  - otherwise nothing moves under the owner's hands: the avatar's dot and
 *    "Reload to update" stay, and the check is made again every few seconds.
 *
 * A page reloads on its own at most once per served build (kept in
 * `sessionStorage`), so a browser that keeps serving the old bundle from a
 * cache cannot loop.
 *
 * A part of the page that failed to load late (a chunk Vite reports, a
 * `loadChunk` caller, a worker that never started) is only a hint: an update
 * deletes the old build's chunks, but so does nothing else, and a network blip
 * or a broken module looks the same from here. `confirmUpdate` asks the
 * gateway at once. A different build is the update above, with one
 * difference: the page is already broken, so it reloads now rather than after
 * a minute idle — unless something is in progress, when the avatar's "Reload
 * to update" is the notice and the idle rule takes over. The same build is an
 * ordinary failure: no reload, and the caller's own fallback stands.
 */
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { buildDiffers, WEB_BUILD } from '../build';
import { hasUnsavedEdits } from '../canvas/file-drafts';

/** How often the shell asks which build is served. */
export const BUILD_CHECK_MS = 5 * 60_000;
/** How long the owner has to have done nothing before the page reloads under them. */
export const IDLE_MS = 60_000;
/** How often a stale page asks itself again whether it is safe to reload. */
export const SAFE_RECHECK_MS = 5_000;
/** Said on `window` when the live stream opens again after a drop. */
export const STREAM_RECONNECTED = 'buddi:stream-reconnected';
/** The served build this tab already reloaded for, once. */
export const AUTO_RELOAD_KEY = 'buddi.autoReloadedFor';
/** Said on `window` when a part of the page failed to load and the gateway said a new build is served: the shell reads the version again. */
export const UPDATE_CONFIRMED = 'buddi:update-confirmed';

/** Tell the shell the live stream is back (`useAttention`'s stream calls this). */
export function announceReconnect(): void {
  window.dispatchEvent(new Event(STREAM_RECONNECTED));
}

/* ---- the owner's last input, for "idle" ---- */

const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart', 'input'] as const;
let lastActivity = Date.now();
let watching = 0;
const touch = (): void => {
  lastActivity = Date.now();
};

function watchActivity(): () => void {
  if (watching === 0) {
    lastActivity = Date.now();
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, touch, { capture: true, passive: true });
  }
  watching += 1;
  return () => {
    watching -= 1;
    if (watching === 0) for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, touch, { capture: true });
  };
}

/** How long since the owner last typed, clicked, scrolled or moved the pointer. */
export function idleFor(now: number = Date.now()): number {
  return now - lastActivity;
}

/** Tests say when the owner last did something. */
export function setLastActivityForTests(at: number): void {
  lastActivity = at;
}

/* ---- is anything in the middle of being done? ---- */

/**
 * Something on the page would be lost by a reload: a composer with text or
 * files in it (Home, the chat, the dock: each marks itself `data-busy`), a
 * recording, an open sheet or dialog, or a file edited on the canvas and not
 * yet saved.
 */
export function somethingInProgress(doc: Document = document): boolean {
  return (
    hasUnsavedEdits() ||
    doc.querySelector('.wb-composer[data-busy="true"]') !== null ||
    doc.querySelector('.wb-listening, [data-recording="true"]') !== null ||
    doc.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null
  );
}

/** Whether a stale page may reload now. */
export function safeToReload(opts: { hidden: boolean; idleMs: number; busy: boolean }): boolean {
  if (opts.hidden) return true;
  return opts.idleMs >= IDLE_MS && !opts.busy;
}

function alreadyReloadedFor(served: string): boolean {
  try {
    return window.sessionStorage.getItem(AUTO_RELOAD_KEY) === served;
  } catch {
    return false;
  }
}

function rememberReloadFor(served: string): void {
  try {
    window.sessionStorage.setItem(AUTO_RELOAD_KEY, served);
  } catch {
    /* Refused storage: at worst one more reload. */
  }
}

/** Ask again for the served build whenever the live stream comes back, or a failed load turned out to be an update. */
export function useCheckOnReconnect(check: () => void): void {
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    const onReconnect = (): void => latest.current();
    window.addEventListener(STREAM_RECONNECTED, onReconnect);
    window.addEventListener(UPDATE_CONFIRMED, onReconnect);
    return () => {
      window.removeEventListener(STREAM_RECONNECTED, onReconnect);
      window.removeEventListener(UPDATE_CONFIRMED, onReconnect);
    };
  }, []);
}

/* ---- a part of the page that would not load ---- */

/** What `confirmUpdate` reads and does; tests swap them. */
export const updateDeps = {
  served: (): Promise<string | undefined> => api.version().then((version) => version.web),
  reload: (): void => window.location.reload(),
  own: (): string | undefined => WEB_BUILD,
};

let asking: Promise<boolean> | null = null;

/**
 * A late load failed: is that because a new build is served? Yes → reload now
 * (once for that build) or, with something in progress, leave it to the
 * avatar's notice. No, or the gateway cannot say → false, and nothing moves.
 * Every hint at once shares one question.
 */
export function confirmUpdate(): Promise<boolean> {
  asking ??= (async () => {
    let served: string | undefined;
    try { served = await updateDeps.served(); } catch { return false; }
    if (!buildDiffers(served, updateDeps.own()) || served === undefined) return false;
    window.dispatchEvent(new Event(UPDATE_CONFIRMED));
    if (!alreadyReloadedFor(served) && !somethingInProgress()) {
      rememberReloadFor(served);
      updateDeps.reload();
    }
    return true;
  })().finally(() => { asking = null; });
  return asking;
}

/** A chunk of this build that could not be loaded because an update replaced it. */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'A part of the page could not be loaded', { cause });
    this.name = 'ChunkLoadError';
  }
}

export function isChunkLoadError(error: unknown): error is ChunkLoadError {
  return error instanceof ChunkLoadError;
}

/** Load a chunk; when it fails and an update is why, the caller gets a `ChunkLoadError`, otherwise the failure as it was. */
export function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  return load().catch(async (error: unknown) => {
    throw (await confirmUpdate()) ? new ChunkLoadError(error) : error;
  });
}

/** Vite's own report of a chunk it could not load is a hint too. Once, from `main.tsx`. */
export function watchChunkFailures(): () => void {
  // Not prevented: the import still rejects, so its caller's fallback stands if the page stays.
  const onError = (): void => { void confirmUpdate(); };
  window.addEventListener('vite:preloadError', onError);
  return () => window.removeEventListener('vite:preloadError', onError);
}

/**
 * Reload onto a new build when it is safe. `served` is the build the gateway
 * says it serves; nothing happens while it is this page's own, or unknown.
 */
export function useAutoReload(
  served: string | undefined,
  reload: () => void = () => window.location.reload(),
  own: string | undefined = WEB_BUILD,
): void {
  const stale = buildDiffers(served, own);
  const doReload = useRef(reload);
  doReload.current = reload;
  useEffect(() => watchActivity(), []);
  useEffect(() => {
    if (!stale || served === undefined || alreadyReloadedFor(served)) return undefined;
    let done = false;
    const consider = (): void => {
      if (done) return;
      const hidden = document.visibilityState === 'hidden';
      if (!safeToReload({ hidden, idleMs: idleFor(), busy: somethingInProgress() })) return;
      done = true;
      rememberReloadFor(served);
      doReload.current();
    };
    consider();
    const timer = window.setInterval(consider, SAFE_RECHECK_MS);
    document.addEventListener('visibilitychange', consider);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', consider);
    };
  }, [stale, served]);
}
