/**
 * The rollback drill: a failed restore must not take an installed plugin's
 * schema with it.
 *
 * The release smoke found this twice in six runs. A restore into installation
 * B failed on purpose at the files step, the engine rolled the pre-restore
 * snapshot back and reported `rolled-back` — and `memory.preferences` was gone
 * until something migrated the database again. The shape behind it is here,
 * deterministically: a schema is dropped because *this installation* owns it
 * (it is in `pluginMigrations`, or the target's own `core.migrations` names
 * it) and is rebuilt only when the archive being loaded names it. An archive
 * that does not — a snapshot taken before that plugin ever migrated, or an
 * archive from an installation that never had it — leaves the schema dropped
 * and not rebuilt, with no row in the ledger to say so.
 *
 * Both halves are checked: the plain rollback, and the load whose archive is
 * silent about a schema this build owns.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate, migrateCore } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { createBackup } from './create.js';
import { restoreBackup, urlForDatabase } from './restore.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

/** A stand-in for a built-in plugin: compiled in here, so always installed. */
const PLUG_SCHEMA = 'rollplug';
const DB = `buddi_rollback_drill_${process.pid}`;

const PLUG_MIGRATION = `
create table if not exists preferences (id serial primary key, key text not null, value text not null);
`;

suite('a rolled-back restore keeps the installed plugins', () => {
  let admin: Pool;
  let work: string;
  let plugDir: string;
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
      { schema: PLUG_SCHEMA, dir: plugDir },
    ],
  });

  /** The migrations this build ships, as the supervisor reports them. */
  const sources = (): Array<{ schema: string; dir: string; plugin: string }> => [
    { schema: PLUG_SCHEMA, dir: plugDir, plugin: 'rollplug' },
  ];

  const fresh = async (): Promise<void> => {
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
  };

  /** A data directory whose `artifacts` is a file: the files step refuses it. */
  const brokenData = async (name: string): Promise<string> => {
    const dir = path.join(work, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'artifacts'), 'not a directory\n');
    return dir;
  };

  const preferences = async (pool: Pool): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from ${PLUG_SCHEMA}.preferences`,
    );
    return Number(rows[0]?.n);
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    url = urlForDatabase(databaseUrl as string, DB);
    work = await mkdtemp(path.join(os.tmpdir(), 'buddi-rollback-'));
    plugDir = path.join(work, 'plug-migrations');
    backupsDir = path.join(work, 'backups');
    dataDir = path.join(work, 'data');
    agentsDir = path.join(work, 'agents');
    skillsDir = path.join(work, 'skills');
    await mkdir(plugDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
    await mkdir(path.join(dataDir, 'artifacts', '2026', '09'), { recursive: true });
    // An artifact in the archive is what makes the files step reach the
    // artifacts directory at all, and that is the step the broken data
    // directory below refuses.
    await writeFile(path.join(dataDir, 'artifacts', '2026', '09', 'deadbeef.txt'), 'artifact bytes\n');
    await writeFile(path.join(plugDir, '001_preferences.sql'), PLUG_MIGRATION);
    await writeFile(path.join(agentsDir, 'rollback-agent.md'), '# a private agent\n');
  }, 300_000);

  afterAll(async () => {
    if (admin) {
      await admin.query(`drop database if exists ${DB}`).catch(() => {});
      await admin.end().catch(() => {});
    }
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('puts the plugin schema back when the restore fails and rolls back', async () => {
    await fresh();
    let pool = createPool(url);
    try {
      await migrateCore(pool);
      await migrate(pool, { schema: PLUG_SCHEMA, dir: plugDir });
      await pool.query(`insert into ${PLUG_SCHEMA}.preferences (key, value) values ('note', 'kept')`);
    } finally {
      await pool.end().catch(() => {});
    }

    const created = await createBackup(base());
    const report = await restoreBackup({
      ...base(),
      dataDir: await brokenData('broken-rollback'),
      archive: created.archive,
      yes: true,
      typed: DB,
      pluginMigrations: sources(),
      force: true,
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);

    pool = createPool(url);
    try {
      // The row the snapshot held, in a table the rollback had to rebuild.
      expect(await preferences(pool)).toBe(1);
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from core.migrations where schema = $1`,
        [PLUG_SCHEMA],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await pool.end().catch(() => {});
    }
  }, 900_000);

  it('rebuilds a schema this build owns that the archive never heard of', async () => {
    /*
     * The archive is taken before the plugin ever migrated here, which is what
     * a snapshot of a target that has only just started looks like. The target
     * then has the plugin's schema, so the load drops it: it has to come back
     * empty and migrated, not disappear until something else migrates.
     */
    await fresh();
    let pool = createPool(url);
    try {
      await migrateCore(pool);
    } finally {
      await pool.end().catch(() => {});
    }
    const created = await createBackup({
      ...base(),
      migrationDirs: [{ schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR }],
    });

    pool = createPool(url);
    try {
      await migrate(pool, { schema: PLUG_SCHEMA, dir: plugDir });
      await pool.query(`insert into ${PLUG_SCHEMA}.preferences (key, value) values ('note', 'gone')`);
    } finally {
      await pool.end().catch(() => {});
    }

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      yes: true,
      typed: DB,
      pluginMigrations: sources(),
      force: true,
    });
    expect(report.ok).toBe(true);

    pool = createPool(url);
    try {
      // Empty, because the archive carried none of its rows — but present,
      // and recorded in the ledger, which is the state the installation runs
      // in. Before this was fixed the schema was simply absent.
      expect(await preferences(pool)).toBe(0);
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from core.migrations where schema = $1`,
        [PLUG_SCHEMA],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await pool.end().catch(() => {});
    }
  }, 900_000);
});
