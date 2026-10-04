/**
 * The suite with React's scheduler starved (src/test/starve.ts): how a loaded
 * CI runner orders renders, effects and promises, reproduced on a laptop.
 *
 *   pnpm --filter @buddi/web exec vitest run -c vitest.starve.config.ts
 *   STARVE_MS=100 STARVE_JITTER=1 pnpm --filter @buddi/web exec vitest run -c vitest.starve.config.ts
 */
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: { ...base.test, setupFiles: ['./src/test/starve.ts', './src/test/setup.ts'], retry: 0 },
});
