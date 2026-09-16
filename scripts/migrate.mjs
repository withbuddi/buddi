#!/usr/bin/env node
/**
 * Root `db:migrate`. Core migrates always; each plugin only if it is built.
 * Core with zero plugins installed is a valid, running state.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(repoRoot, '.env') });

const { createPool, hydrateDatabaseUrl, runMigrations } = await import('@buddi/core');

// `DATABASE_URL` is assembled from the vault rather than written into `.env`
// with the password in clear. An explicit one in the environment still wins.
const { url, source } = await hydrateDatabaseUrl(process.env);
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env, then `buddi db up`)');
  process.exit(1);
}
console.log(`database: ${source === 'env' ? 'DATABASE_URL from the environment' : `assembled (${source})`}`);

const manifests = [];
/**
 * Every plugin that is built, read from the directory rather than from a list.
 *
 * The list this used to hold named finance, memory, artifacts and email, and
 * the web plugin shipped after it was written — so `pnpm db:migrate` silently
 * stopped creating one plugin's schema. A directory listing cannot fall behind
 * the directory. Core with zero plugins installed is still a valid state.
 */
const toolsDir = path.join(repoRoot, 'packages', 'tools');
const builtIn = (await readdir(toolsDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const name of builtIn) {
  const entry = path.join(toolsDir, name, 'dist', 'index.js');
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
