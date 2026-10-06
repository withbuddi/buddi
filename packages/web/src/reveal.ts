/**
 * Showing what is hidden by default — balances, pay — and hiding it again.
 *
 * One rule for every sensitive surface (Home's blocks, a plugin page's
 * sensitive sections, a page's Show amounts): shown only on asking, and masked
 * again as soon as the window is left, so a screen left unattended shows the
 * shape of things and none of the figures.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Leaving the window: switching to another app (blur, though the browser may
 * still be on screen) or the tab going to the background.
 */
function onLeave(hide: () => void): () => void {
  const hidden = (): void => {
    if (document.visibilityState === 'hidden') hide();
  };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('blur', hide);
  return () => {
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('blur', hide);
  };
}

/** Calls `hide` whenever the window is left, while `active`. */
export function useHideOnLeave(active: boolean, hide: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    return onLeave(() => hide());
    // `hide` is a setter or a module function: stable enough not to re-subscribe on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** One reveal of its own: a Home block, a sensitive section. */
export function useReveal(): [boolean, () => void] {
  const [revealed, setRevealed] = useState(false);
  useHideOnLeave(revealed, () => setRevealed(false));
  return [revealed, () => setRevealed((v) => !v)];
}

/** How long Show amounts holds before the figures mask themselves again. */
export const AMOUNTS_SHOWN_MS = 5 * 60_000;

/*
 * Show amounts is one switch for the session (this tab): pressed on the Money
 * page, it holds on the next page too, until the window is left or five
 * minutes pass. Kept in memory only, so a reload starts masked. The leave
 * listener belongs to the switch, not to a page: it holds while the owner is
 * on Home or Settings too, where nothing that reads it is mounted.
 */
let shownUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let unlisten: (() => void) | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setAmountsShown(shown: boolean, now: number = Date.now()): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  shownUntil = shown ? now + AMOUNTS_SHOWN_MS : 0;
  if (shown) timer = setTimeout(() => setAmountsShown(false), AMOUNTS_SHOWN_MS);
  if (shown && !unlisten && typeof window !== 'undefined') unlisten = onLeave(() => setAmountsShown(false));
  if (!shown && unlisten) {
    unlisten();
    unlisten = undefined;
  }
  emit();
}

function amountsShown(): boolean {
  return shownUntil > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session's Show amounts: whether it is on, and the toggle. */
export function useAmountsShown(): [boolean, () => void] {
  const shown = useSyncExternalStore(subscribe, amountsShown, amountsShown);
  return [shown, () => setAmountsShown(!amountsShown())];
}
