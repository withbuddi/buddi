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
 */
import { useEffect, useRef } from 'react';
import { buildDiffers, WEB_BUILD } from '../build';

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
 * recording, or an open sheet or dialog.
 */
export function somethingInProgress(doc: Document = document): boolean {
  return (
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

/** Ask again for the served build whenever the live stream comes back. */
export function useCheckOnReconnect(check: () => void): void {
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    const onReconnect = (): void => latest.current();
    window.addEventListener(STREAM_RECONNECTED, onReconnect);
    return () => window.removeEventListener(STREAM_RECONNECTED, onReconnect);
  }, []);
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
