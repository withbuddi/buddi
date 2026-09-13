#!/usr/bin/env node
/**
 * Migration entrypoint. Core migrates first, then each plugin manifest in order.
 * Core with zero plugins is a valid, running state — an empty manifest list is fine.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from './db.js';
import type { AppliedMigration } from './db.js';
import type { PluginManifest } from './tools.js';

export async function runMigrations(
  pool: Pool,
  manifests: PluginManifest[] = [],
): Promise<AppliedMigration[]> {
  const applied: AppliedMigration[] = [];
  applied.push(...(await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR })));
  for (const manifest of manifests) {
    applied.push(
      ...(await migrate(pool, {
        schema: manifest.schema,
        dir: manifest.migrationsDir,
      })),
    );
  }
  return applied;
}

/** `buddi-migrate` — loads .env from the repo root, migrates core only. */
export async function main(): Promise<void> {
  const { config } = await import('dotenv');
  config();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (copy .env.example to .env)');
    process.exitCode = 1;
    return;
  }
  const pool = createPool(url);
  try {
    const applied = await runMigrations(pool, []);
    if (applied.length === 0) console.log('migrations: up to date');
    for (const m of applied) console.log(`applied ${m.schema}/${m.filename}`);
  } finally {
    await pool.end();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
