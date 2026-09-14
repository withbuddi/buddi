/**
 * The dashboard build.
 *
 * Two rules the config exists to keep: the output is plain static files the
 * gateway serves from `packages/web/dist`, and **nothing is fetched at
 * runtime** — no CDN, no font host, no analytics. Everything the page needs is
 * in the bundle, which is also what makes "no external requests at all" a fact
 * about the build rather than a promise in a README.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
