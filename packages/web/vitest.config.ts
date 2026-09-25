/** The UI's own test runner: jsdom, and the same React plugin the build uses. */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // jsdom on a CI runner is slow; a minute per test rather than twenty seconds.
    testTimeout: 60_000,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
