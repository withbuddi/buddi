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
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate, migrateCore } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { createArchive, extractAll } from './archive.js';
import { createBackup } from './create.js';
import { encryptFile } from './crypt.js';
import { loadDatabase } from './load.js';
import { generatePassphrase } from './passphrase.js';
import { urlForDatabase } from './restore.js';
import { restoreBackup } from './restore.js';
import { verifyBackup } from './verify.js';

/** One passphrase for the encrypted round trip; scrypt is not free. */
const PASSPHRASE = generatePassphrase();

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DRILL_SCHEMA = 'drill';
const DB = `buddi_backup_drill_${process.pid}`;
/** The second database, for the `--into` drill. Dropped with the first. */
const INTO_DB = `${DB}_into`;
/**
 * The third: a database owned by an ordinary login role, which is what a
 * packaged installation actually restores as. Dropped with the others.
 */
const ROLE_DB = `${DB}_role`;
const ROLE = `buddi_drill_nosuper_${process.pid}`;
const ROLE_PASSWORD = 'drill_not_a_secret';

const OLD_MIGRATION = `
create table accounts (id serial primary key, name text not null, cents bigint not null);
create table entries (id serial primary key, account int not null references accounts(id), note text);
-- An identity column, because it is the one column shape that COPY treats
-- differently from every other: generated always refuses an INSERT without
-- overriding system value, a clause COPY has no syntax for at all.
create table ledgers (id int generated always as identity primary key, label text not null);
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
  let pluginsFile: string;
  let url: string;

  const base = (): Parameters<typeof createBackup>[0] => ({
    databaseUrl: url,
    backupsDir,
    dataDir,
    agentsDir,
    skillsDir,
    timezone: 'America/New_York',
    vault: false,
    pluginsFile,
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
      await pool.query(`insert into drill.ledgers (label) values ('opening'), ('closing')`);
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
    pluginsFile = path.join(work, 'plugins.json');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
    await mkdir(path.join(dataDir, 'artifacts', '2026', '09'), { recursive: true });
    await writeFile(path.join(oldDir, '001_tables.sql'), OLD_MIGRATION);
    await writeFile(path.join(newDir, '001_tables.sql'), OLD_MIGRATION);
    await writeFile(path.join(newDir, '002_note.sql'), NEW_MIGRATION);
    await writeFile(pluginsFile, `${JSON.stringify([{ name: 'buddi-plugin-drill', version: '1.0.0' }])}\n`);
    await writeFile(path.join(agentsDir, 'drill-agent.md'), '# a private agent\n');
    await writeFile(path.join(skillsDir, 'drill-skill.md'), '# a private skill\n');
    await writeFile(path.join(dataDir, 'artifacts', '2026', '09', 'deadbeef.txt'), 'artifact bytes\n');

    await seed(oldDir);
  }, 300_000);

  afterAll(async () => {
    if (admin) {
      await admin.query(`drop database if exists ${ROLE_DB}`).catch(() => {});
      await admin.query(`drop role if exists ${ROLE}`).catch(() => {});
      await admin.query(`drop database if exists ${INTO_DB}`).catch(() => {});
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
    // A file the archive does not have: if the private directory were merged
    // rather than replaced, or not put back after the failure, it would go.
    await writeFile(path.join(agentsDir, 'not-in-the-archive.md'), '# mine\n');

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

    // And the files the failed restore wrote are gone: the private directory
    // holds what it held before, including the file the archive never had.
    expect(existsSync(path.join(agentsDir, 'not-in-the-archive.md'))).toBe(true);
    expect(existsSync(path.join(brokenData, 'restored-plugins.json'))).toBe(false);
    const leftovers = (await readdir(work)).filter(
      (name) => name.includes('.restoring-') || name.includes('.previous-'),
    );
    expect(leftovers).toEqual([]);
  }, 900_000);

  it('restores an identity column, its values and the sequence behind it', async () => {
    await seed(oldDir);
    const created = await createBackup(base());
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.ok).toBe(true);

    const pool = createPool(url);
    try {
      const { rows } = await pool.query<{ id: number; label: string }>(
        `select id, label from drill.ledgers order by id`,
      );
      // The ids themselves came back, not new ones: anything pointing at them
      // still points at the same row.
      expect(rows).toEqual([
        { id: 1, label: 'opening' },
        { id: 2, label: 'closing' },
      ]);
      const { rows: next } = await pool.query<{ id: number }>(
        `insert into drill.ledgers (label) values ('next') returning id`,
      );
      expect(next[0]?.id).toBe(3);
    } finally {
      await pool.end().catch(() => {});
    }
  }, 600_000);

  it('restores an encrypted archive that arrived with no envelope beside it', async () => {
    await seed(oldDir);
    const created = await createBackup(base());
    // An upload: one `.age` file, picked in a file dialog, with the `.json`
    // envelope left behind on the machine that made it.
    const encrypted = `${created.archive}.age`;
    await encryptFile(created.archive, encrypted, PASSPHRASE);
    await rm(created.archive);

    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);

    const verified = await verifyBackup({ archive: encrypted, passphrase: PASSPHRASE });
    expect(verified.problems).toEqual([]);
    expect(verified.checks.find((c) => c.name === 'envelope')?.detail).toContain('no envelope');

    const report = await restoreBackup({
      ...base(),
      archive: encrypted,
      passphrase: PASSPHRASE,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.didNot.join('\n')).not.toMatch(/did not verify/);
    expect(report.ok).toBe(true);

    // The archive's plugin record is left where the recovery checklist reads it.
    const restoredPlugins = path.join(dataDir, 'restored-plugins.json');
    expect(existsSync(restoredPlugins)).toBe(true);
    expect((await stat(restoredPlugins)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(restoredPlugins, 'utf8'))[0].name).toBe('buddi-plugin-drill');

    const pool = createPool(url);
    try {
      expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
    } finally {
      await pool.end().catch(() => {});
    }
  }, 900_000);

  it('refuses a manifest that points the private directories out of the archive', async () => {
    await seed(oldDir);
    const created = await createBackup(base());

    // The manifest is not covered by the member checksums — it is the document
    // that lists them — so editing it is exactly the attack this guards.
    const unpacked = path.join(work, 'tampered-stage');
    await rm(unpacked, { recursive: true, force: true });
    await extractAll(created.archive, unpacked);
    const manifestFile = path.join(unpacked, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.private.agents.archivePath = '../../../outside';
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    const tampered = path.join(backupsDir, 'buddi-backup-20260101-000000.tar.gz');
    await createArchive(unpacked, tampered);

    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);

    const report = await restoreBackup({
      ...base(),
      archive: tampered,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    // The rest of the restore is fine; the private agents are not read at all.
    expect(report.didNot.join('\n')).toMatch(/refusing to read from it/);
    expect(report.did.join('\n')).not.toMatch(/private agents/);
    expect(existsSync(path.join(work, 'outside'))).toBe(false);
  }, 900_000);

  it('rolls the whole restore back when the afterDatabase hook throws', async () => {
    await seed(oldDir);
    const created = await createBackup(base());
    const before = createPool(url);
    try {
      await before.query(`insert into drill.accounts (name, cents) values ('brokerage', 99)`);
    } finally {
      await before.end().catch(() => {});
    }

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      yes: true,
      typed: DB,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
      afterDatabase: async () => {
        throw new Error('the recovery record could not be written');
      },
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(report.didNot.join('\n')).toMatch(/the recovery record could not be written/);

    const after = createPool(url);
    try {
      expect(await counts(after)).toEqual({ accounts: 4, entries: 5 });
    } finally {
      await after.end().catch(() => {});
    }
  }, 900_000);

  it('snapshots an empty database when the installation still holds files', async () => {
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    await seed(oldDir);
    const created = await createBackup(base());

    // A target with no tables at all, but agents and artifacts on disk: there
    // is everything to lose here and the old rule gave it no snapshot.
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.ok).toBe(true);
    expect(report.snapshot).not.toBeNull();
    expect(report.did.join('\n')).toMatch(/snapshotted/);
  }, 900_000);

  it('restores the database only when --into names another database', async () => {
    await seed(oldDir);
    const created = await createBackup(base());
    await writeFile(path.join(agentsDir, 'only-here.md'), '# not in that archive\n');

    // The checklist record an earlier restore in this suite left behind.
    await rm(path.join(dataDir, 'restored-plugins.json'), { force: true });

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      into: INTO_DB,
      yes: true,
      typed: INTO_DB,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.ok).toBe(true);
    expect(report.didNot.join('\n')).toContain(
      'files were not touched; add --files to restore agents, skills and artifacts too',
    );
    expect(report.did.join('\n')).not.toMatch(/private agents/);
    // The installation beside it is untouched, including the file the archive
    // has never heard of and the checklist record a full restore would write.
    expect(existsSync(path.join(agentsDir, 'only-here.md'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'restored-plugins.json'))).toBe(false);

    const pool = createPool(urlForDatabase(databaseUrl as string, INTO_DB));
    try {
      expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
    } finally {
      await pool.end().catch(() => {});
    }
  }, 900_000);

  it('restores the files as well when --files is asked for', async () => {
    await seed(oldDir);
    // Out of the way before the archive is taken, so it is genuinely a file
    // the archive does not have when it goes back in below.
    await rm(path.join(agentsDir, 'only-here.md'), { force: true });
    const created = await createBackup(base());
    await writeFile(path.join(agentsDir, 'only-here.md'), '# not in that archive\n');

    const report = await restoreBackup({
      ...base(),
      archive: created.archive,
      into: INTO_DB,
      yes: true,
      typed: INTO_DB,
      files: true,
      pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      force: true,
    });
    expect(report.ok).toBe(true);
    expect(report.didNot.join('\n')).not.toContain('files were not touched');
    expect(report.did.join('\n')).toMatch(/private agents/);
    // Replaced, not merged: the file the archive does not have is gone.
    expect(existsSync(path.join(agentsDir, 'only-here.md'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'restored-plugins.json'))).toBe(true);
  }, 900_000);

  /**
   * The packaged installation's own role.
   *
   * `session_replication_role` is a superuser parameter. A packaged buddi
   * connects as an ordinary login role, which Postgres refuses it — and a
   * refused statement aborts the whole transaction, so without a savepoint
   * around it every COPY that follows fails with "current transaction is
   * aborted" and a restore that should have worked ends rolled back. This is
   * the only place that shape can be reproduced: every other suite here runs
   * as the superuser the developer's cluster hands out.
   */
  it('loads as a role that is refused session_replication_role', async () => {
    const { rows: who } = await admin.query<{ superuser: boolean }>(
      `select rolsuper as superuser from pg_roles where rolname = current_user`,
    );
    // Without a superuser there is no way to make a second role to test with.
    if (who[0]?.superuser !== true) return;

    await seed(oldDir);
    const created = await createBackup(base());
    const stage = path.join(work, 'stage-nosuper');
    await rm(stage, { recursive: true, force: true });
    await extractAll(created.archive, stage);

    await admin.query(`drop database if exists ${ROLE_DB}`);
    await admin.query(`drop role if exists ${ROLE}`);
    // Everything the restore needs and nothing more: a login, and ownership of
    // its own empty database so it may create and drop schemas inside it.
    await admin.query(`create role ${ROLE} login password '${ROLE_PASSWORD}'`);
    await admin.query(`create database ${ROLE_DB} owner ${ROLE}`);

    const target = new URL(urlForDatabase(databaseUrl as string, ROLE_DB));
    target.username = ROLE;
    target.password = ROLE_PASSWORD;

    const pool = createPool(target.toString());
    try {
      const { rows: role } = await pool.query<{ superuser: boolean }>(
        `select rolsuper as superuser from pg_roles where rolname = current_user`,
      );
      expect(role[0]?.superuser).toBe(false);

      const report = await loadDatabase(pool, stage, {
        pluginMigrations: [{ schema: DRILL_SCHEMA, dir: oldDir, plugin: 'drill' }],
      });
      // The parameter was refused — and the rows went in anyway.
      expect(report.triggersLeftOn).toBe(true);
      expect(report.notLoaded).toEqual([]);
      expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
      const { rows: inserted } = await pool.query<{ id: number }>(
        `insert into drill.accounts (name, cents) values ('brokerage', 1) returning id`,
      );
      expect(inserted[0]?.id).toBe(4);
    } finally {
      await pool.end().catch(() => {});
    }
  }, 900_000);

  describe('what the loader refuses before it drops anything', () => {
    /** A stage directory holding only the three index files a load reads. */
    const stageWith = async (
      name: string,
      migrations: Record<string, unknown>,
      manifest?: Record<string, unknown>,
    ): Promise<string> => {
      const dir = path.join(work, name);
      await mkdir(path.join(dir, 'db'), { recursive: true });
      await writeFile(path.join(dir, 'db', 'migrations.json'), JSON.stringify(migrations));
      await writeFile(path.join(dir, 'db', 'tables.json'), '[]');
      await writeFile(path.join(dir, 'db', 'sequences.json'), '[]');
      if (manifest) await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      return dir;
    };

    it('refuses an archive that names "public" as one of its schemas', async () => {
      await seed(oldDir);
      const stage = await stageWith('stage-public', {
        core: [],
        plugins: { public: { schema: 'public', filenames: ['001_x.sql'] } },
      });
      const pool = createPool(url);
      try {
        await expect(loadDatabase(pool, stage)).rejects.toThrow(/not buddi's to drop/);
        // Nothing was dropped: the target is exactly as it was.
        expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
      } finally {
        await pool.end().catch(() => {});
      }
    }, 600_000);

    it('refuses a dump from a newer buddi with the target untouched', async () => {
      await seed(oldDir);
      const stage = await stageWith('stage-newer', {
        core: ['999_from_the_future.sql'],
        plugins: {},
      });
      const pool = createPool(url);
      try {
        await expect(loadDatabase(pool, stage)).rejects.toThrow(/taken by a newer buddi/);
        expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
      } finally {
        await pool.end().catch(() => {});
      }
    }, 600_000);

    it('refuses an archive whose manifest format is newer than this build', async () => {
      await seed(oldDir);
      const stage = await stageWith('stage-format', { core: [], plugins: {} }, { format: 99 });
      const pool = createPool(url);
      try {
        await expect(loadDatabase(pool, stage)).rejects.toThrow(/this build reads format/);
        expect(await counts(pool)).toEqual({ accounts: 3, entries: 5 });
      } finally {
        await pool.end().catch(() => {});
      }
    }, 600_000);
  });
});
