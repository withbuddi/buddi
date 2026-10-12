/**
 * The owner's browser by name, for every sentence that used to say "Chrome":
 * "your Edge" to an owner on Edge, "your Chrome" on Chrome, and "your
 * browser" when nothing says which.
 *
 * The paired extension names its browser to the gateway (`ExtensionState.
 * browser`, packages/extension/src/brand.ts); before any pairing, or with an
 * extension from before it said, this page's own browser stands in, which on
 * the owner's computer is the same one. The gateway and the browser tool use
 * the same words (packages/tools/browser/src/brand.ts); keep them in step.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

/** What the extension may say, and the word an owner uses for each. */
const WORDS: Record<string, string> = {
  'Microsoft Edge': 'Edge', 'Google Chrome': 'Chrome', Brave: 'Brave', Opera: 'Opera', Vivaldi: 'Vivaldi', Arc: 'Arc',
};

/** The parts of `navigator` this reads (a copy of the extension's rule, packages/extension/src/brand.ts). */
export interface BrandHints {
  userAgent?: string;
  userAgentData?: { brands?: readonly { brand: string }[] } | null;
  brave?: unknown;
  arc?: boolean;
}

/** "Microsoft Edge", "Google Chrome", … or undefined for a browser this cannot name (Safari, Firefox, an unknown Chromium). */
export function detectBrowser(hints: BrandHints | undefined): string | undefined {
  if (!hints) return undefined;
  const ua = hints.userAgent ?? '';
  const brands = (hints.userAgentData?.brands ?? []).map((entry) => String(entry?.brand ?? ''));
  const has = (pattern: RegExp) => brands.some((brand) => pattern.test(brand));
  if (has(/^Microsoft Edge$/) || /\bEdg\//.test(ua)) return 'Microsoft Edge';
  if (has(/^Opera/) || /\bOPR\//.test(ua)) return 'Opera';
  if (has(/^Brave$/) || hints.brave) return 'Brave';
  if (/\bVivaldi\//.test(ua) || has(/^Vivaldi$/)) return 'Vivaldi';
  if (hints.arc) return 'Arc';
  if (has(/^Google Chrome$/)) return 'Google Chrome';
  // Safari and Firefox have no brand list either; only a plain Chrome user agent counts.
  if (brands.length === 0 && /\bChrome\//.test(ua) && !/\bChromium\/|\bCriOS\/|Firefox\//.test(ua)) return 'Google Chrome';
  return undefined;
}

/** This page's browser. */
export function pageBrowser(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & { userAgentData?: BrandHints['userAgentData']; brave?: unknown };
  let arc = false;
  try { arc = getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-title').trim() !== ''; } catch { /* not Arc as far as we know */ }
  return detectBrowser({ userAgent: nav.userAgent, userAgentData: nav.userAgentData, brave: nav.brave, arc });
}

/** "Edge", "Chrome", … or undefined. */
export function browserWord(brand: string | undefined): string | undefined {
  return brand !== undefined && Object.prototype.hasOwnProperty.call(WORDS, brand) ? WORDS[brand] : undefined;
}

/** "your Edge", or "your browser". */
export function yourBrowser(word: string | undefined): string { return `your ${word ?? 'browser'}`; }
/** "Your Edge", or "Your browser". */
export function YourBrowser(word: string | undefined): string { return `Your ${word ?? 'browser'}`; }
/** "Edge", or "your browser": where a sentence names the program ("Open Edge on Scout"). */
export function theBrowser(word: string | undefined): string { return word ?? 'your browser'; }

/** Where the browser lists its extensions (Edge takes chrome:// too, but says edge://). */
export function extensionsPage(word: string | undefined): string {
  const scheme = word === 'Edge' ? 'edge' : word === 'Brave' ? 'brave' : word === 'Opera' ? 'opera' : word === 'Vivaldi' ? 'vivaldi' : 'chrome';
  return `${scheme}://extensions`;
}

/** The store button's words: every one of them installs from the Chrome Web Store. */
export function storeLabel(word: string | undefined): string {
  if (word === 'Chrome') return 'Add to Chrome';
  return word ? `Get the buddi extension (Chrome Web Store, works in ${word})` : 'Get the buddi extension (Chrome Web Store)';
}

/* ---- what the gateway last said about the paired browser ---- */

let paired: string | undefined;
let asked = false;
const listeners = new Set<() => void>();

/** The gateway's `/api/extension` answer: the paired browser's name, or none. */
export function rememberBrowser(state: { browser?: string; pairedAt?: string | null } | undefined | null): void {
  if (!state) return;
  asked = true;
  const next = state.pairedAt ? state.browser : undefined;
  if (next === paired) return;
  paired = next;
  for (const listener of listeners) listener();
}

/** For tests: forget what the gateway said. */
export function resetBrowserName(): void { paired = undefined; asked = false; for (const listener of listeners) listener(); }

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => paired;

/** The owner's browser in one word ("Edge"), or undefined for "your browser". */
export function currentBrowserWord(): string | undefined { return browserWord(paired ?? pageBrowser()); }

/**
 * The same, as a hook: asks the gateway once per page load (the Browser page
 * keeps it current while it is open), and this page's browser meanwhile.
 */
export function useBrowserWord(): string | undefined {
  const brand = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (asked) return;
    asked = true;
    try { void Promise.resolve(api.extension?.()).then(rememberBrowser, () => undefined); } catch { /* no gateway answer: the page's own browser */ }
  }, []);
  return browserWord(brand ?? pageBrowser());
}
