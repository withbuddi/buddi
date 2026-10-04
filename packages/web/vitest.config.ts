/** The UI's own test runner: jsdom, and the same React plugin the build uses. */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import RetriedTests from '../../scripts/ci/retried-tests.mjs';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // jsdom on a CI runner is slow; a minute per test rather than twenty seconds.
    testTimeout: 60_000,
    // A stopgap, not a fix: a test that needs a retry is a race to be fixed at
    // the root. The gate lists every test that passed only on a retry in its
    // job summary (see .github/workflows/gate.yml), so flakes stay visible.
    retry: process.env.CI ? 2 : 0,
    reporters: process.env.VITEST_RETRIED ? ['default', new RetriedTests(process.env.VITEST_RETRIED, 'packages/web')] : ['default'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
