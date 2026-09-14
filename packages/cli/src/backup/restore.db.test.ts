/**
 * The restore drill.
 *
 * A backup nobody has restored is a rumour. This test is the drill, run against
 * real Postgres through the real code path: make a throwaway database with
 * tables and rows in it, take a real `buddi backup create` of it, verify the
 * archive the way `buddi backup verify` does, restore it into a *second*
 * throwaway database, and assert the row counts came back.
 *
 * Skipped unless DATABASE_URL is set, like every other db-backed test here —
 * and it additionally needs the compose container up, because that is where
 * `pg_dump` and `pg_restore` live.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPool } from '@buddi/core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../paths.js';
import { createBackup } from './create.js';
import { KNOWN_SECRETS } from '@buddi/core';
import { DUMP_NAME, MANIFEST_NAME, isCustomFormatDump, secretValuesIn } from './manifest.js';
import { listMembers, readMember } from './archive.js';
import {
  createDatabase,
  databaseFootprint,
  parseDatabaseUrl,
  restoreDatabase,
  tableCounts,
  urlForDatabase,
} from './pg.js';
import { verifyArchive } from './verify.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const SOURCE_DB = `buddi_backup_src_${process.pid}`;
const TARGET_DB = `buddi_backup_dst_${process.pid}`;

suite('a backup can actually be restored', () => {
  let admin: Pool;
  let source: Pool;
  let target: Pool;
  let workdir: string;
  let outDir: string;
  let privateDir: string;
  let skillsDir: string;
  let dataDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    for (const db of [SOURCE_DB, TARGET_DB]) {
      await admin.query(`drop database if exists ${db}`);
      await admin.query(`create database ${db}`);
    }

    source = createPool(urlForDatabase(databaseUrl as string, SOURCE_DB));
    // Two tables, two shapes, both with rows: enough that a dump which silently
    // restored nothing could not pass by accident.
    await source.query(`create schema drill`);
    await source.query(
      `create table drill.accounts (id serial primary key, name text not null, cents bigint not null)`,
    );
    await source.query(
      `create table drill.entries (id serial primary key, account int references drill.accounts(id), note text)`,
    );
    await source.query(
      `insert into drill.accounts (name, cents) values ('checking', 120000), ('savings', 4500000), ('cash', 700)`,
    );
    await source.query(
      `insert into drill.entries (account, note) values (1, 'rent'), (1, 'groceries'), (2, 'transfer'), (2, 'interest'), (3, 'coffee')`,
    );

    workdir = await mkdtemp(path.join(os.tmpdir(), 'buddi-drill-'));
    outDir = path.join(workdir, 'backups');
    privateDir = path.join(workdir, 'agents');
    skillsDir = path.join(workdir, 'skills');
    dataDir = path.join(workdir, 'data');
    await mkdir(privateDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
    await mkdir(path.join(dataDir, 'artifacts', '2026', '09'), { recursive: true });
    await writeFile(path.join(privateDir, 'drill-agent.md'), '# a private agent\n');
    await writeFile(path.join(skillsDir, 'drill-skill.md'), '# a private skill\n');
    await writeFile(path.join(dataDir, 'artifacts', '2026', '09', 'deadbeef.txt'), 'artifact bytes\n');

    env = {
      ...process.env,
      DATABASE_URL: urlForDatabase(databaseUrl as string, SOURCE_DB),
      BUDDI_AGENTS_DIR: privateDir,
      BUDDI_SKILLS_DIR: skillsDir,
      BUDDI_DATA_DIR: dataDir,
    };
  }, 120_000);

  afterAll(async () => {
    await source?.end().catch(() => {});
    await target?.end().catch(() => {});
    if (admin) {
      for (const db of [SOURCE_DB, TARGET_DB]) {
        await admin.query(`drop database if exists ${db}`).catch(() => {});
      }
      await admin.end().catch(() => {});
    }
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it('creates, verifies and restores — and the rows come back', async () => {
    /* create -------------------------------------------------------- */
    const created = await createBackup({ env, out: outDir });
    expect(created.archive.startsWith(outDir)).toBe(true);
    expect(created.bytes).toBeGreaterThan(0);

    const counts = new Map(created.manifest.tables.map((t) => [t.table, t.rows]));
    expect(counts.get('drill.accounts')).toBe(3);
    expect(counts.get('drill.entries')).toBe(5);
    expect(created.manifest.database.name).toBe(SOURCE_DB);
    expect(created.manifest.private.agents?.files).toBe(1);
    expect(created.manifest.private.skills?.files).toBe(1);
    expect(created.manifest.artifacts).toMatchObject({ included: true, count: 1 });

    /* the archive holds what it says, and no secret ------------------- */
    const members = await listMembers(created.archive);
    expect(members).toContain(MANIFEST_NAME);
    expect(members).toContain(DUMP_NAME);
    expect(members).toContain('private/agents/drill-agent.md');
    expect(members).toContain('artifacts/2026/09/deadbeef.txt');
    expect(isCustomFormatDump(await readMember(created.archive, DUMP_NAME))).toBe(true);
    const manifestText = (await readMember(created.archive, MANIFEST_NAME)).toString('utf8');
    expect(manifestText).toContain('"secrets"');
    // The scrubbed .env travels; no value from this machine's real .env does.
    const scrubbed = (await readMember(created.archive, 'env.scrubbed')).toString('utf8');
    const realEnv = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8').catch(() => ''),
    );
    for (const value of secretValuesIn(realEnv, KNOWN_SECRETS)) {
      expect(scrubbed).not.toContain(value);
      expect(manifestText).not.toContain(value);
    }

    /* verify --------------------------------------------------------- */
    const verified = await verifyArchive(created.archive);
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(verified.checks.every((c) => c.ok)).toBe(true);

    /* restore into a second throwaway database ------------------------ */
    const serverTarget = parseDatabaseUrl(databaseUrl as string);
    const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-drill-restore-'));
    try {
      const { extractAll } = await import('./archive.js');
      await extractAll(created.archive, stage);
      await restoreDatabase({
        repoRoot: REPO_ROOT,
        target: serverTarget,
        database: TARGET_DB,
        inFile: path.join(stage, DUMP_NAME),
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }

    target = createPool(urlForDatabase(databaseUrl as string, TARGET_DB));
    const restored = new Map((await tableCounts(target)).map((t) => [t.table, t.rows]));
    expect(restored.get('drill.accounts')).toBe(3);
    expect(restored.get('drill.entries')).toBe(5);

    // Not just the counts: the rows themselves.
    const { rows } = await target.query<{ name: string; cents: string }>(
      `select name, cents::text as cents from drill.accounts order by id`,
    );
    expect(rows).toEqual([
      { name: 'checking', cents: '120000' },
      { name: 'savings', cents: '4500000' },
      { name: 'cash', cents: '700' },
    ]);
  }, 300_000);

  it('--no-artifacts leaves the files out and the manifest says so', async () => {
    const created = await createBackup({ env, out: outDir, noArtifacts: true });
    expect(created.manifest.artifacts.included).toBe(false);
    expect(created.manifest.artifacts.count).toBe(0);
    expect(created.manifest.artifacts.skipped).toMatch(/1 file\(s\)/);
    const members = await listMembers(created.archive);
    expect(members.some((m) => m.startsWith('artifacts/'))).toBe(false);
    // The database and the private directories are still there — skipping the
    // artifact bytes is not skipping the backup.
    expect(members).toContain(DUMP_NAME);
    expect(members).toContain('private/agents/drill-agent.md');
    expect((await verifyArchive(created.archive)).ok).toBe(true);
  }, 300_000);

  it('a database with rows in it reports a footprint the guard can refuse', async () => {
    const footprint = await databaseFootprint(source);
    expect(footprint.tables).toBeGreaterThanOrEqual(2);
    expect(footprint.rows).toBeGreaterThanOrEqual(8);
  }, 60_000);

  it('createDatabase is idempotent enough to be usable twice in a drill', async () => {
    const serverTarget = parseDatabaseUrl(databaseUrl as string);
    const name = `buddi_backup_tmp_${process.pid}`;
    await admin.query(`drop database if exists ${name}`);
    await createDatabase({ repoRoot: REPO_ROOT, target: serverTarget, database: name });
    await expect(
      createDatabase({ repoRoot: REPO_ROOT, target: serverTarget, database: name }),
    ).rejects.toThrow(/already exists/);
    await admin.query(`drop database if exists ${name}`);
  }, 60_000);
});
