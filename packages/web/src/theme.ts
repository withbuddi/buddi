/**
 * Light, dark, or whatever the machine says.
 *
 * The choice is one attribute on `<html>`: `data-theme="light"`,
 * `data-theme="dark"`, or absent for "follow the system". `tokens.css` reads
 * exactly those three states, so nothing here knows a colour and nothing here
 * touches a style — this file's whole job is to set one attribute and remember
 * it.
 *
 * Remembering it is `localStorage` and nothing else: no request, no cookie,
 * nothing the server is told. A dashboard should not report on your eyes.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_KEY = 'buddi.theme';

export const THEME_ORDER: ThemeChoice[] = ['light', 'dark', 'system'];

/** Light → Dark → System → Light. The cycle the toggle walks. */
export function nextTheme(current: ThemeChoice): ThemeChoice {
  const index = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'system';
}

/** What was stored, or "system" when nothing was — or when storage is denied. */
export function readTheme(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): ThemeChoice {
  try {
    const stored = storage?.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function storeTheme(choice: ThemeChoice, storage = safeStorage()): void {
  try {
    storage?.setItem(THEME_KEY, choice);
  } catch {
    // A private window that refuses storage still gets a working toggle; it
    // just forgets between reloads.
  }
}

/**
 * Put the choice on the document. "system" *removes* the attribute rather than
 * writing "system" — the media query is the fallback, and an attribute that
 * says nothing should not exist.
 */
export function applyTheme(choice: ThemeChoice, root: HTMLElement | null = document.documentElement): void {
  if (!root) return;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/** What the owner will actually see, once the system has had its say. */
export function effectiveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function themeLabel(choice: ThemeChoice): string {
  return choice === 'system' ? 'System theme' : choice === 'dark' ? 'Dark theme' : 'Light theme';
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
