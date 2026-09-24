/**
 * How the dashboard looks in this browser: theme, background and page width.
 *
 * Three attributes on `<html>`, each absent at its default so the stylesheet's
 * bare `:root` is the default: `data-theme` (see `theme.ts`), `data-ground`
 * ("sand", or absent for blue) and `data-width` ("narrow" or "full", absent
 * for wide). Remembered in `localStorage` and nowhere else — this is a
 * browser's preference, not the installation's, and the server is never told.
 *
 * The same three keys are read by the inline script in `index.html` before
 * the first paint, so a reload in dark or on sand never flashes the defaults.
 * Every storage access is in a try: a private window that refuses storage
 * still gets working controls; it just forgets between reloads.
 */
import { useSyncExternalStore } from 'react';
import { THEME_KEY, applyTheme, readTheme, storeTheme, type ThemeChoice } from './theme';

export type Ground = 'blue' | 'sand';
export type PageWidth = 'narrow' | 'wide' | 'full';

export const GROUND_KEY = 'buddi.ground';
export const WIDTH_KEY = 'buddi.pageWidth';

export interface Appearance {
  theme: ThemeChoice;
  ground: Ground;
  width: PageWidth;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', ground: 'blue', width: 'wide' };

export function readAppearance(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Appearance {
  const get = (key: string): string | null => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const ground = get(GROUND_KEY);
  const width = get(WIDTH_KEY);
  return {
    theme: readTheme(storage),
    ground: ground === 'sand' ? 'sand' : 'blue',
    width: width === 'narrow' || width === 'full' ? width : 'wide',
  };
}

/** Put the choices on the document; a default removes its attribute. */
export function applyAppearance(appearance: Appearance, root: HTMLElement | null = document.documentElement): void {
  if (!root) return;
  applyTheme(appearance.theme, root);
  if (appearance.ground === 'sand') root.setAttribute('data-ground', 'sand');
  else root.removeAttribute('data-ground');
  if (appearance.width === 'wide') root.removeAttribute('data-width');
  else root.setAttribute('data-width', appearance.width);
}

function store(appearance: Appearance, storage = safeStorage()): void {
  storeTheme(appearance.theme, storage);
  try {
    storage?.setItem(GROUND_KEY, appearance.ground);
    storage?.setItem(WIDTH_KEY, appearance.width);
  } catch {
    // Refused storage: the choice holds for this page and is forgotten after.
  }
}

/* ---- one shared value, so the rail's menu and Settings agree ---- */

let current: Appearance | null = null;
const listeners = new Set<() => void>();

function snapshot(): Appearance {
  if (!current) current = readAppearance();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAppearance(patch: Partial<Appearance>): void {
  current = { ...snapshot(), ...patch };
  applyAppearance(current);
  store(current);
  for (const listener of listeners) listener();
}

/** Forget the shared value; tests start each case from storage. */
export function resetAppearanceForTests(): void {
  current = null;
}

export function useAppearance(): [Appearance, (patch: Partial<Appearance>) => void] {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  return [value, setAppearance];
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The keys the pre-paint script in `index.html` reads; kept here so a rename is one search. */
export const APPEARANCE_KEYS = [THEME_KEY, GROUND_KEY, WIDTH_KEY] as const;
