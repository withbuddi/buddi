#!/usr/bin/env node
/**
 * Root `db:migrate`. Core migrates always; each plugin only if it is built.
 * Core with zero plugins installed is a valid, running state.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(repoRoot, '.env') });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

const { createPool, runMigrations } = await import('@buddi/core');

const manifests = [];
/** Every plugin that is built. Core with zero plugins installed is a valid state. */
for (const name of ['finance', 'memory', 'artifacts']) {
  const entry = path.join(repoRoot, 'packages', 'tools', name, 'dist', 'index.js');
  if (!existsSync(entry)) continue;
  const mod = await import(entry);
  const manifest = mod.manifest ?? mod.default;
  if (manifest && typeof manifest === 'object' && 'migrationsDir' in manifest) {
    manifests.push(manifest);
    console.log(
      manifest.migrationsDir
        ? `plugin: ${manifest.name}@${manifest.version} (schema ${manifest.schema})`
        : `plugin: ${manifest.name}@${manifest.version} (no schema of its own)`,
    );
  }
}

const pool = createPool(url);
try {
  const applied = await runMigrations(pool, manifests);
  if (applied.length === 0) console.log('migrations: up to date');
  for (const m of applied) console.log(`applied ${m.schema}/${m.filename}`);
} finally {
  await pool.end();
}
