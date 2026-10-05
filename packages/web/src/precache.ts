/**
 * `dist/precache.json`: what the service worker keeps for a gateway that does
 * not answer.
 *
 * The shell and nothing else: `index.html`, the hashed JS and CSS Vite just
 * wrote, the fonts they load, and the Blob's stills and loops. Never an API
 * path — what buddi knows stays with buddi; the worker keeps only the page
 * that says it is out of reach. The worker (`public/sw.js`) fetches this list
 * at install, so it never needs bundling.
 */
import type { Plugin } from 'vite';

/** Paths relative to the page, as the worker resolves them against its scope. */
export function precacheList(bundled: readonly string[], publicFiles: readonly string[]): string[] {
  const keep = (file: string): boolean =>
    !/^(api|stream|preview)(\/|$)/.test(file) &&
    (/^assets\/.+\.(js|css|woff2)$/.test(file) || /^mascot\/(anim\/)?[\w-]+\.(png|json)$/.test(file) || /^favicon(-\d+)?\.(png|ico)$/.test(file));
  return ['index.html', ...[...bundled, ...publicFiles].filter(keep).sort()];
}

export function precacheManifest(build: string, publicFiles: () => string[]): Plugin {
  return {
    name: 'buddi-precache',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = precacheList(Object.keys(bundle), publicFiles());
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: `${JSON.stringify({ build, files }, null, 2)}\n` });
    },
  };
}
