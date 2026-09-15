/**
 * Core's own runner. The global setup resolves the database once and says so.
 * Core reads it from source; every other package resolves the built module.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/testing/global-setup.ts'],
  },
});
