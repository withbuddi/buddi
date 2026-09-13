#!/usr/bin/env node
/**
 * Root `db:migrate`. Core migrates always; the finance plugin only if it is built.
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
const financeDist = path.join(repoRoot, 'packages', 'tools', 'finance', 'dist');
if (existsSync(path.join(financeDist, 'index.js'))) {
  const mod = await import(path.join(financeDist, 'index.js'));
  const manifest = mod.manifest ?? mod.financeManifest ?? mod.default;
  if (manifest && typeof manifest === 'object' && 'migrationsDir' in manifest) {
    manifests.push(manifest);
    console.log(`plugin: ${manifest.name}@${manifest.version} (schema ${manifest.schema})`);
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
