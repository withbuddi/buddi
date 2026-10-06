/**
 * Core's own runner. The isolated global setup takes the database from an
 * explicit DATABASE_URL only and says so.
 * Core reads it from source; every other package resolves the built module.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Isolated: an explicit DATABASE_URL only (the keychain is never asked), never port 55433, the memory vault for every worker.
    globalSetup: ['./src/testing/isolated-global-setup.ts'],
  },
});
