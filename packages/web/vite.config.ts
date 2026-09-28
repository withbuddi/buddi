/**
 * The dashboard build.
 *
 * Two rules the config exists to keep: the output is plain static files the
 * gateway serves from `packages/web/dist`, and **nothing is fetched at
 * runtime** — no CDN, no font host, no analytics. Everything the page needs is
 * in the bundle, which is also what makes "no external requests at all" a fact
 * about the build rather than a promise in a README.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * This build's own name: the package version plus the commit it was built
 * from. The page carries it as `__BUDDI_WEB_BUILD__`, and `build.json` beside
 * it says the same to the gateway, which reports it as `web` on
 * `/api/version`. A page whose name differs from the one being served is a
 * page from before an upgrade, and the owner menu offers to reload it.
 */
function webBuild(): string {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  let sha = '';
  try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { /* No git (a tarball build): the version alone. */ }
  return sha ? `${version}+${sha}` : version;
}

const WEB_BUILD = webBuild();

/** `dist/build.json`: the build's name, for the gateway to read. */
function buildManifest(): Plugin {
  return {
    name: 'buddi-build-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: `${JSON.stringify({ web: WEB_BUILD })}\n` });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildManifest()],
  define: { __BUDDI_WEB_BUILD__: JSON.stringify(WEB_BUILD) },
  // Assets are referenced relatively, so the page works wherever it is mounted.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One vendor chunk, hashed filenames; the server caches those immutably.
    sourcemap: false,
  },
  server: {
    // `pnpm --filter @buddi/web dev` proxies the API to a running `buddi serve`.
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
