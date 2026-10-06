/**
 * Showing what is hidden by default — balances, pay — and hiding it again.
 *
 * One rule for every sensitive surface (Home's blocks, a plugin page's
 * sensitive sections, a page's Show amounts): shown only on asking, and masked
 * again as soon as the window is left, so a screen left unattended shows the
 * shape of things and none of the figures.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

/** Calls `hide` whenever the tab is hidden, while `active`. */
export function useHideOnLeave(active: boolean, hide: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    const check = (): void => {
      if (document.visibilityState === 'hidden') hide();
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('blur', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('blur', check);
    };
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
 * minutes pass. Kept in memory only, so a reload starts masked.
 */
let shownUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setAmountsShown(shown: boolean, now: number = Date.now()): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  shownUntil = shown ? now + AMOUNTS_SHOWN_MS : 0;
  if (shown) timer = setTimeout(() => setAmountsShown(false), AMOUNTS_SHOWN_MS);
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
  useHideOnLeave(shown, () => setAmountsShown(false));
  return [shown, () => setAmountsShown(!amountsShown())];
}
