/**
 * `@buddi/core/testing` — the one entry besides `@buddi/core/plugin` a
 * plugin's tests may import (docs/plugin-host-api.md §6).
 *
 * A plugin's tests drive it through core's real machinery: a registry, a
 * migrated database, the approval path, a host built as `register()` builds
 * it. So this is all of core, plus how the suites find their database. It is
 * for `*.test.ts` alone: `plugin-imports.test.ts` fails a plugin source that
 * imports it, and the `@buddi/core` an installed plugin resolves has no
 * `testing` to import.
 */
export * from '../index.js';
export * from './database-url.js';
