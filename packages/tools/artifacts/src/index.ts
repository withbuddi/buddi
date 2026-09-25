/**
 * @buddi/tool-artifacts — reading the artifact store.
 *
 * The one plugin that owns no schema. Artifacts are a core domain concept
 * (docs/architecture.md, "Data model"): core holds the table because approvals,
 * transcripts and runs all reference it, and a dropped plugin must not take the
 * owner's files with it. What is droppable is *this* — the agent-facing reads
 * over that store — so `migrationsDir` is empty and uninstalling removes tools,
 * not data.
 *
 * Every tool is a read or a pure extraction, so the family is tier `auto`.
 */
import type { PluginManifest } from '@buddi/core/plugin';
import { describe, list, text } from './tools/artifacts.js';

/** This plugin ships no migrations: it reads `core.artifacts`. */
export const MIGRATIONS_DIR = '';

export const manifest: PluginManifest = {
  name: 'artifacts',
  version: '0.1.0',
  // Core's own schema. Declared for the registry's sake; nothing is created or
  // dropped here, which is exactly what an empty migrationsDir means.
  schema: 'core',
  migrationsDir: MIGRATIONS_DIR,
  tools: [list, describe, text],
  uses: ['files:library'],
};

export default manifest;

export { list, describe, text };
export type { ArtifactSummary, ArtifactDescription } from './tools/artifacts.js';
export * from './extract.js';
