/**
 * The owner's browser by name: "your Edge" for an owner on Edge, "your
 * Chrome" on Chrome, and "your browser" when the extension did not say (one
 * from before it said, or a Chromium it does not know).
 *
 * The extension names its browser in its hello (packages/extension/src/brand.ts);
 * the gateway keeps that with the pairing and hands it here through
 * `ExtensionBridge.browser`. The dashboard has the same words in
 * packages/web/src/browser-name.ts; keep them in step.
 */

/** What the extension may say, and the word an owner uses for each. */
const WORDS: Record<string, string> = {
  'Microsoft Edge': 'Edge', 'Google Chrome': 'Chrome', Brave: 'Brave', Opera: 'Opera', Vivaldi: 'Vivaldi', Arc: 'Arc',
};

/** One of the names the extension sends, or undefined: anything else on the wire is dropped, never shown. */
export function browserBrand(raw: unknown): string | undefined {
  return typeof raw === 'string' && Object.hasOwn(WORDS, raw) ? raw : undefined;
}

/** "Edge", "Chrome", … or undefined when the browser is not known. */
export function browserWord(brand: string | undefined): string | undefined {
  return brand !== undefined && Object.hasOwn(WORDS, brand) ? WORDS[brand] : undefined;
}

/** "your Edge", or "your browser". */
export function yourBrowser(brand: string | undefined): string {
  return `your ${browserWord(brand) ?? 'browser'}`;
}

/** "Your Edge", or "Your browser", to start a sentence. */
export function YourBrowser(brand: string | undefined): string {
  return `Your ${browserWord(brand) ?? 'browser'}`;
}
