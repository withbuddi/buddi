/**
 * `migrate` and the directory it is given.
 *
 * Two cases, both found by the release smoke. A plugin that names a
 * `migrationsDir` is a plugin saying it owns tables, so a directory that is
 * not on disk is an error naming the path, not "nothing to do": the silent
 * version installed plugins owning empty schemas. And the usual way to get
 * there is a path built with `new URL('./migrations', import.meta.url).pathname`,
 * which percent-encodes a space — under a data directory called `owner data`,
 * or `~/Library/Application Support/...`, every migration was skipped without
 * a word. A path with a space in it is therefore a case this tests directly.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from './db.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const SCHEMA = `migrate_drill_${process.pid}`;

suite('migrate and its migrations directory', () => {
  let work: string;
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'buddi-migrate-'));
    pool = createPool(databaseUrl as string);
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`drop schema if exists "${SCHEMA}" cascade`).catch(() => {});
      await pool.query(`delete from core.migrations where schema = $1`, [SCHEMA]).catch(() => {});
      await pool.end().catch(() => {});
    }
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('applies migrations from a directory whose path contains a space', async () => {
    const dir = path.join(work, 'owner data', 'migrations');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '001_note.sql'), 'create table if not exists note (id serial primary key);\n');

    const applied = await migrate(pool, { schema: SCHEMA, dir });
    expect(applied.map((a) => a.filename)).toEqual(['001_note.sql']);
    // The table is really there, which is the thing the silent version lost.
    const { rows } = await pool.query<{ present: boolean }>(
      `select to_regclass($1) is not null as present`,
      [`"${SCHEMA}".note`],
    );
    expect(rows[0]?.present).toBe(true);
  }, 120_000);

  it('refuses a migrations directory that is not on disk, naming it', async () => {
    const missing = path.join(work, 'owner data', 'not-here');
    await expect(migrate(pool, { schema: SCHEMA, dir: missing })).rejects.toThrow(missing);
    await expect(migrate(pool, { schema: SCHEMA, dir: missing })).rejects.toThrow(
      /no migrations directory/,
    );
  }, 120_000);
});
