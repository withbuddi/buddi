/**
 * @buddi/tool-memory — memory v1 as a plugin.
 *
 * Two kinds, separated on purpose (ARCHITECTURE.md, "Memory"): explicit user
 * preferences, which the owner authors and corrects by revision, and derived
 * memories, which an agent writes with provenance, scope and an expiry. No
 * embeddings yet — v1 is preferences plus source-linked notes, and recall is a
 * keyword search.
 *
 * Every tool is a read or a write over this plugin's own schema, so the family
 * is tier `auto`. None of it is a capability: memory informs reasoning and
 * never grants permission.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core';
import { getPreferences, rememberPreference } from './tools/preferences.js';
import { forget, note, recall } from './tools/notes.js';

/** Absolute path to this plugin's migrations, resolved from the built file. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export const manifest: PluginManifest = {
  name: 'memory',
  version: '0.1.0',
  schema: 'memory',
  migrationsDir: MIGRATIONS_DIR,
  tools: [rememberPreference, getPreferences, note, recall, forget],
};

export default manifest;

export { rememberPreference, getPreferences, note, recall, forget };
export { currentPreferences } from './tools/preferences.js';
export { selectNotes, scopesFor } from './tools/notes.js';
export * from './preamble.js';
