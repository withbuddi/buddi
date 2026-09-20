/**
 * The restore drill.
 *
 * A backup nobody has restored is a rumour. This is the drill, against real
 * Postgres through the real code path: migrate a throwaway database (core plus
 * a stand-in plugin schema with a foreign key and a sequence), put rows in it,
 * dump, drop and recreate the database, restore, and check that the rows, the
 * foreign keys and the *sequences* came back — the last of which is what
 * decides whether the first insert after a restore works at all.
 *
 * Three more things are checked here because they cannot be checked anywhere
 * else: a dump taken at an older migration level restores into a build whose
 * plugin has a newer migration; a plugin that is not installed is reported
 * rather than fatal; and a restore whose file step fails leaves the target
 * exactly at the pre-restore snapshot.
 *
 * Every database this suite touches is one it created, named after this
 * process, and dropped again.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate, migrateCore } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { createBackup } from './create.js';
import { urlForDatabase } from './restore.js';
import { restoreBackup } from './restore.js';
import { verifyBackup } from './verify.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DRILL_SCHEMA = 'drill';
const DB = `buddi_backup_drill_${process.pid}`;

const OLD_MIGRATION = `
create table accounts (id serial primary key, name text not null, cents bigint not null);
create table entries (id serial primary key, account int not null references accounts(id), note text);
`;
const NEW_MIGRATION = `alter table accounts add column note text;`;

suite('a backup can actually be restored', () => {
  let admin: Pool;
  let work: string;
  let oldDir: string;
  let newDir: string;
  let backupsDir: string;
  let dataDir: string;
  let agentsDir: string;
  let skillsDir: string;
  let url: string;

  const base = (): Parameters<typeof createBackup>[0] => ({
    databaseUrl: url,
    backupsDir,
    dataDir,
    agentsDir,
    skillsDir,
    timezone: 'America/New_York',
    vault: false,
    migrationDirs: [
      { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR },
      { schema: DRILL_SCHEMA, dir: oldDir },
    ],
  });

  /** A freshly created database with core, the drill schema and its rows. */
  const seed = async (migrationsDir: string): Promise<void> => {
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    const pool = createPool(url);
    try {
      await migrateCore(pool);
      await migrate(pool, { schema: DRILL_SCHEMA, dir: migrationsDir });
      await pool.query(
        `insert into drill.accounts (name, cents) values ('checking', 120000), ('savings', 4500000), ('cash', 700)`,
      );
      await pool.query(
        `insert into drill.entries (account, note)
         values (1, 'rent'), (1, 'groceries'), (2, 'transfer'), (2, 'interest'), (3, 'coffee')`,
      );
    } finally {
      await pool.end().catch(() => {});
    }
  };

  const counts = async (pool: Pool): Promise<{ accounts: number; entries: number }> => {
    const { rows } = await pool.query<{ accounts: string; entries: string }>(
      `select (select count(*) from drill.accounts)::text as accounts,
              (select count(*) from drill.entries)::text as entries`,
    );
    return { accounts: Number(rows[0]?.accounts), entries: Number(rows[0]?.entries) };
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    url = urlForDatabase(databaseUrl as string, DB);

    work = await mkdtemp(path.join(os.tmpdir(), 'buddi-drill-'));
    oldDir = path.join(work, 'migrations-old');
    newDir = path.join(work, 'migrations-new');
    backupsDir = path.join(work, 'backups');
    dataDir = path.join(work, 'data');
    agentsDir = path.join(work, 'agents');
    skillsDir = path.join(work, 'skills');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
    await mkdir(path.join(dataDir, 'artifacts', '2026', '09'), { recursive: true });
    await writeFile(path.join(oldDir, '001_tables.sql'), OLD_MIGRATION);
    await writeFile(path.join(newDir, '001_tables.sql'), OLD_MIGRATION);
    await writeFile(path.join(newDir, '002_note.sql'), NEW_MIGRATION);
    await writeFile(path.join(agentsDir, 'drill-agent.md'), '# a private agent\n');
    await writeFile(path.join(skillsDir, 'drill-skill.md'), '# a private skill\n');
    await writeFile(path.join(dataDir, 'artifacts', '2026', '09', 'deadbeef.txt'), 'artifact bytes\n');

    await seed(oldDir);
  }, 300_000);

  afterAll(async () => {
    if (admin) {
      await admin.query(`drop database if exists ${DB}`).catch(() => {});
      await admin.end().catch(() => {});
    }
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('dumps, verifies, and restores into a database that was dropped and recreated', async () => {
    const created = await createBackup(base());
    expect(created.bytes).toBeGreaterThan(0);
    const tables = new Map(created.manifest.tables.map((t) => [t.table, t.rows]));
    expect(tables.get('drill.accounts')).toBe(3);
    expect(tables.get('drill.entries')).toBe(5);
    expect(created.manifest.postgresMajor).toBeGreaterThanOrEqual(13);
    expect(created.manifest.buddiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(created.manifest.private.agents?.files).toBe(1);

    const verified = await verifyBackup({ archive: created.archive });
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);

    // The target is gone entirely: nothing below can pass on leftovers.
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.didNot.join('\n')).not.toMatch(/did not verify/);
    expect(report.ok).toBe(true);
    expect(report.database?.notLoaded).toEqual([]);

    const pool = createPool(url);
    try {
      expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
      const { rows } = await pool.query<{ name: string; cents: string }>(
        `select name, cents::text as cents from drill.accounts order by id`,
      );
      expect(rows).toEqual([
        { name: 'checking', cents: '120000' },
        { name: 'savings', cents: '4500000' },
        { name: 'cash', cents: '700' },
      ]);

      // The sequence continues where it left off: the next id is 4, not 1.
      const { rows: inserted } = await pool.query<{ id: number }>(
        `insert into drill.accounts (name, cents) values ('brokerage', 1) returning id`,
      );
      expect(inserted[0]?.id).toBe(4);
      // And the foreign key is a foreign key again, not a column of integers.
      await expect(
        pool.query(`insert into drill.entries (account, note) values (999, 'nowhere')`),
      ).rejects.toThrow(/foreign key/i);
    } finally {
      await pool.end().catch(() => {});
    }
  }, 600_000);

  it('restores a dump taken at an older migration level, then applies the newer one', async () => {
    await seed(oldDir);
    const created = await createBackup(base());
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);

    // The same plugin, one migration further on than the dump knows about.
    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: newDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.ok).toBe(true);
    expect(report.database?.applied.map((a) => a.filename)).toContain('002_note.sql');

    const pool = createPool(url);
    try {
      expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
      // The newer migration ran on top of the restored data.
      const { rows } = await pool.query(
        `select note from drill.accounts order by id limit 1`,
      );
      expect(rows[0]).toEqual({ note: null });
    } finally {
      await pool.end().catch(() => {});
    }
  }, 600_000);

  it('reports a plugin it cannot rebuild instead of failing the whole restore', async () => {
    await seed(oldDir);
    const created = await createBackup(base());
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      pluginMigrations: [],
      force: true,
    });
    expect(report.ok).toBe(true);
    expect(report.database?.notLoaded.map((n) => n.schema)).toEqual([DRILL_SCHEMA]);

    const pool = createPool(url);
    try {
      // Core came back; the plugin's schema is honestly absent, and nothing
      // claims its migrations were applied.
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from core.migrations where schema = $1`,
        [DRILL_SCHEMA],
      );
      expect(rows[0]?.n).toBe('0');
      await expect(pool.query(`select 1 from drill.accounts`)).rejects.toThrow();
    } finally {
      await pool.end().catch(() => {});
    }
  }, 600_000);

  it('leaves the target at the pre-restore snapshot when a file step fails', async () => {
    await seed(oldDir);
    const created = await createBackup(base());

    // The target moves on after the archive was taken: four accounts, not three.
    const before = createPool(url);
    try {
      await before.query(`insert into drill.accounts (name, cents) values ('brokerage', 99)`);
      expect(await counts(before)).toEqual({ accounts: 4, entries: 5 });
    } finally {
      await before.end().catch(() => {});
    }

    // A data directory whose `artifacts` is a file, not a directory: the
    // artifact step fails, after the database has already been replaced.
    const brokenData = path.join(work, 'broken');
    await mkdir(brokenData, { recursive: true });
    await writeFile(path.join(brokenData, 'artifacts'), 'not a directory\n');

    const report = await restoreBackup({
      ...base(),
      dataDir: brokenData,
      archive: created.archive,
      // The guard: a target with rows in it needs the name typed back.
      yes: true,
      typed: DB,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(report.snapshot).not.toBeNull();
    expect(report.didNot.join('\n')).toMatch(/the restore failed/);

    const after = createPool(url);
    try {
      // Back at the snapshot: four accounts, not the archive's three.
      expect(await counts(after)).toEqual({ accounts: 4, entries: 5 });
    } finally {
      await after.end().catch(() => {});
    }
  }, 900_000);
});
