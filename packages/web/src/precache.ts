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

/** What `generateBundle` is handed, as far as the list reads it. */
type BundleEntry = { type?: string; isEntry?: boolean; facadeModuleId?: string | null; imports?: string[]; dynamicImports?: string[]; viteMetadata?: { importedAssets?: Set<string> } };

/** The Office previewers' entries (`src/chat/office/`): loaded when a file is opened, never kept offline. */
const OFFICE_ENTRY = /[\\/]src[\\/]chat[\\/]office[\\/]/;

/**
 * The files only an Office previewer loads — its chunk, what nothing else
 * imports, and the parser and worker it brings — which the shell never needs
 * offline: megabytes the worker would otherwise fetch at every install.
 */
export function officeOnly(bundle: Record<string, BundleEntry>): Set<string> {
  const walk = (starts: string[], skip: (name: string) => boolean): Set<string> => {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name) || skip(name) || !bundle[name]) continue;
      seen.add(name);
      const chunk = bundle[name]!;
      queue.push(...(chunk.imports ?? []), ...(chunk.dynamicImports ?? []), ...(chunk.viteMetadata?.importedAssets ?? []));
    }
    return seen;
  };
  const isOffice = (name: string): boolean => OFFICE_ENTRY.test(bundle[name]?.facadeModuleId ?? '');
  const office = walk(Object.keys(bundle).filter(isOffice), () => false);
  const shell = walk(Object.keys(bundle).filter((name) => bundle[name]!.isEntry), isOffice);
  return new Set([...office].filter((name) => !shell.has(name)));
}

export function precacheManifest(build: string, publicFiles: () => string[]): Plugin {
  return {
    name: 'buddi-precache',
    apply: 'build',
    generateBundle(_options, bundle) {
      const office = officeOnly(bundle as unknown as Record<string, BundleEntry>);
      const files = precacheList(Object.keys(bundle).filter((name) => !office.has(name)), publicFiles());
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: `${JSON.stringify({ build, files }, null, 2)}\n` });
    },
  };
}
