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
  },
});
