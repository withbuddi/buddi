/**
 * The global setup resolves `DATABASE_URL` the way the application does — the
 * vault included — and prints one line saying whether the DB suites will run
 * or be skipped. See `packages/core/src/testing/global-setup.ts`.
 */
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const resolve = createRequire(import.meta.url).resolve;

export default defineConfig({
  test: {
    globalSetup: [resolve('@buddi/core/testing/global-setup')],
    // A DB suite's afterAll drops its throwaway database, and DROP DATABASE
    // waits for a checkpoint. With every package's suites dropping at once on
    // a slow disk (Docker Desktop on macOS), those queue past the 10 s default.
    hookTimeout: 60_000,
  },
});
