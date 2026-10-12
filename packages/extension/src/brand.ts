/**
 * Which Chromium browser this is, so buddi can say "your Edge" rather than
 * "your Chrome" to an owner who never used Chrome.
 *
 * The extension runs unchanged in Chrome, Edge, Brave, Opera, Vivaldi and Arc;
 * only the name differs. `navigator.userAgentData.brands` names Edge, Chrome,
 * Opera and Brave outright (the worker has it as well as a page). Brave also
 * shows itself as `navigator.brave`, Vivaldi and Opera in the user agent.
 * Arc gives itself away only to a page (its `--arc-palette-*` CSS variables),
 * so it is checked when a document is there. Anything else is undefined: the
 * words fall back to "your browser".
 *
 * A copy of this lives in the dashboard (packages/web/src/browser-name.ts),
 * which names its own page's browser before any pairing; keep them in step.
 */

export const BROWSER_BRANDS = ['Microsoft Edge', 'Google Chrome', 'Brave', 'Opera', 'Vivaldi', 'Arc'] as const;
export type BrowserBrand = (typeof BROWSER_BRANDS)[number];

/** The parts of `navigator` (and the page, when there is one) this reads. */
export interface BrandHints {
  userAgent?: string;
  userAgentData?: { brands?: readonly { brand: string }[] } | null;
  brave?: unknown;
  /** True when the page carries Arc's palette variables. */
  arc?: boolean;
}

export function detectBrowser(hints: BrandHints | undefined): BrowserBrand | undefined {
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
  // No brand list (an old Chromium, or a test): a plain Chrome user agent with none of the others' marks.
  if (brands.length === 0 && /\bChrome\//.test(ua) && !/\bChromium\//.test(ua)) return 'Google Chrome';
  return undefined;
}

/** This browser, from the worker's or the page's own `navigator`. */
export function thisBrowser(): BrowserBrand | undefined {
  try {
    const nav = (globalThis as { navigator?: BrandHints }).navigator;
    const doc = (globalThis as { document?: Document }).document;
    let arc = false;
    try { arc = !!doc?.documentElement && getComputedStyle(doc.documentElement).getPropertyValue('--arc-palette-title').trim() !== ''; } catch { /* no styles: not Arc as far as we know */ }
    return detectBrowser(nav ? { userAgent: nav.userAgent, userAgentData: nav.userAgentData, brave: nav.brave, arc } : undefined);
  } catch {
    return undefined;
  }
}
