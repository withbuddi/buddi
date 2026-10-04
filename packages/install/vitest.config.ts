/**
 * Several of these tests run real processes (a Postgres binary stand-in, tar,
 * npm fakes), which a loaded CI runner spawns slowly: thirty seconds a test
 * rather than vitest's five.
 *
 * `retry` on CI is a stopgap, not a fix: a test that needs it is a race to be
 * fixed at the root. The gate keeps them visible: its job summary lists every
 * test that passed only on a retry (see `.github/workflows/gate.yml`).
 */
import { defineConfig } from 'vitest/config';
import RetriedTests from '../../scripts/ci/retried-tests.mjs';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    retry: process.env.CI ? 2 : 0,
    reporters: process.env.VITEST_RETRIED ? ['default', new RetriedTests(process.env.VITEST_RETRIED, 'packages/install')] : ['default'],
  },
});
