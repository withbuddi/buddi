/**
 * The isolated global setup: an explicit `DATABASE_URL` only (the vault is
 * never asked), never the dev database's port 55433, and BUDDI_VAULT=memory
 * for every worker. It prints one line saying whether the DB suites will run
 * or be skipped. See `packages/core/src/testing/isolated-global-setup.ts`.
 */
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const resolve = createRequire(import.meta.url).resolve;

export default defineConfig({
  test: {
    globalSetup: [resolve('@buddi/core/testing/isolated-global-setup')],
  },
});
