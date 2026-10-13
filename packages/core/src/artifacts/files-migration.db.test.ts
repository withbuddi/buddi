/**
 * Migration 083 on data written by the build before it: files inferred from
 * artifact rows become core.files rows, once, by the rule the code used; the
 * "(vN)" mark moves out of names into `version`; the owner's in-place edits
 * become his versions; deleted rows, duplicates and rows outside any
 * conversation all land somewhere sensible.
 *
 * Skipped unless DATABASE_URL is set; a throwaway database when it runs.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_files_migration_test_${process.pid}`;

suite('migration 083: files as rows', () => {
  let admin: Pool;
  let pool: Pool;
  let conversation: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR, upTo: '082_captured_file_origin.sql' });
    conversation = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id;

    let minute = 0;
    const row = async (key: string, values: { filename: string | null; sha: string; by?: string; conversation?: string | null; origin?: string; deleted?: boolean; surface?: string }): Promise<void> => {
      minute += 1;
      const { rows } = await pool.query(
        `insert into core.artifacts (kind, mime, filename, size_bytes, sha256, storage_path, created_by, conversation_id, origin_path, origin_sha256, source_surface, created_at, deleted_at)
         values ('document', 'text/markdown', $1, 1, $2, 'artifacts/2026/10/' || $2 || '.md', $3, $4, $5, $6, $7, timestamptz '2026-10-01 10:00Z' + make_interval(mins => $8), $9)
         returning id`,
        [values.filename, values.sha.padEnd(64, '0'), values.by ?? 'scout', values.conversation === undefined ? conversation : values.conversation,
          values.origin ?? null, values.origin ? values.sha.padEnd(64, '0') : null, values.surface ?? null, minute, values.deleted ? new Date('2026-10-05T00:00:00Z') : null],
      );
      ids[key] = String(rows[0].id);
    };
    // A document and its versions, one of them deleted; the newest the owner edited in place.
    await row('plan1', { filename: 'Plan.md', sha: 'a1' });
    await row('plan2', { filename: 'Plan (v2).md', sha: 'a2' });
    await row('plan3', { filename: 'Plan (v3).md', sha: 'a3', deleted: true });
    await pool.query('insert into core.owner_file_edits (artifact_id, conversation_id, filename) values ($1, $2, $3)', [ids.plan2, conversation, 'Plan (v2).md']);
    // A command's output captured twice, and a document written over it by a near name.
    await row('cap1', { filename: 'list.md', sha: 'b1', origin: 'host/workspaces/k/out/list.md', surface: 'host' });
    await row('cap2', { filename: 'list.md', sha: 'b2', origin: 'host/workspaces/k/out/list.md', surface: 'host' });
    await row('capdoc', { filename: 'List (v2).md', sha: 'b3' });
    // The same bytes twice, outside any conversation, and a name another agent shares.
    await row('loose1', { filename: 'x.md', sha: 'c1', conversation: null });
    await row('loose2', { filename: 'x.md', sha: 'c1', conversation: null });
    await row('other', { filename: 'Plan.md', sha: 'a1', by: 'ledger' });
    // A file every version of which was deleted, and one with no name.
    await row('old', { filename: 'Old.md', sha: 'd1', deleted: true });
    await row('unnamed', { filename: null, sha: 'e1' });

    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
  });

  const version = async (key: string): Promise<{ file_id: string; version: number; filename: string | null; created_by: string; deleted: boolean }> =>
    (await pool.query('select file_id, version, filename, created_by, deleted_at is not null as deleted from core.artifacts where id = $1', [ids[key]])).rows[0];
  const file = async (key: string): Promise<Record<string, any>> =>
    (await pool.query('select f.* from core.files f join core.artifacts a on a.file_id = f.id where a.id = $1', [ids[key]])).rows[0];

  it('makes one file of a document’s versions, numbered, with no mark left in any name', async () => {
    const [one, two, three] = [await version('plan1'), await version('plan2'), await version('plan3')];
    expect(new Set([one.file_id, two.file_id, three.file_id]).size).toBe(1);
    expect([one.version, two.version, three.version]).toEqual([1, 2, 3]);
    expect([one.filename, two.filename, three.filename]).toEqual(['Plan.md', 'Plan.md', 'Plan.md']);
    // The deleted version stays deleted, and keeps its number.
    expect(three.deleted).toBe(true);
    expect(await file('plan1')).toMatchObject({ name: 'Plan.md', created_by: 'scout', origin: 'document', deleted_at: null, conversation_id: conversation });
    // 084: the counter sits past every version the file ever had, the deleted v3 included.
    expect((await file('plan1')).next_version).toBe(4);
  });

  it('gives the owner the version he edited in place, and keeps the file the agent’s', async () => {
    expect((await version('plan2')).created_by).toBe('owner');
    expect((await version('plan1')).created_by).toBe('scout');
    expect((await file('plan2')).created_by).toBe('scout');
  });

  it('makes a command’s captures and the document written over it one capture file, with its workspace path', async () => {
    const [a, b, c] = [await version('cap1'), await version('cap2'), await version('capdoc')];
    expect(new Set([a.file_id, b.file_id, c.file_id]).size).toBe(1);
    expect([a.version, b.version, c.version]).toEqual([1, 2, 3]);
    expect(await file('cap1')).toMatchObject({ origin: 'capture', origin_path: 'host/workspaces/k/out/list.md', origin_sha256: 'b2'.padEnd(64, '0') });
  });

  it('keeps rows outside a conversation, and another agent’s same-named file, files of their own', async () => {
    expect((await version('loose1')).file_id).not.toBe((await version('loose2')).file_id);
    expect((await version('other')).file_id).not.toBe((await version('plan1')).file_id);
    expect(await file('loose1')).toMatchObject({ conversation_id: null, name: 'x.md', origin: 'document' });
  });

  it('marks a file deleted when every version was, and keeps an unnamed row as its own file', async () => {
    expect((await file('old')).deleted_at).not.toBeNull();
    expect(await file('unnamed')).toMatchObject({ name: null, deleted_at: null });
  });

  it('drops what lived beside the rows, and lets two versions share bytes', async () => {
    const { rows } = await pool.query(`select to_regclass('core.owner_file_edits') as edits,
      exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'artifacts' and column_name = 'origin_path') as origin`);
    expect(rows[0]).toEqual({ edits: null, origin: false });
    const plan = await version('plan1');
    await pool.query(
      `insert into core.artifacts (kind, mime, filename, size_bytes, sha256, storage_path, created_by, file_id, version)
       select kind, mime, filename, size_bytes, sha256, storage_path, 'owner', file_id, 4 from core.artifacts where id = $1`,
      [ids.plan1],
    );
    expect((await pool.query('select count(*)::int as n from core.artifacts where file_id = $1', [plan.file_id])).rows[0].n).toBe(4);
  });

  it('gives a row inserted without a file a file of its own', async () => {
    const { rows } = await pool.query(
      `insert into core.artifacts (kind, mime, filename, size_bytes, sha256, storage_path, created_by)
       values ('document', 'text/plain', 'direct.txt', 1, $1, 'artifacts/2026/10/x.txt', 'owner') returning file_id, version`,
      ['f'.repeat(64)],
    );
    expect(rows[0].version).toBe(1);
    expect((await pool.query('select name, origin, next_version from core.files where id = $1', [rows[0].file_id])).rows[0]).toEqual({ name: 'direct.txt', origin: 'upload', next_version: 2 });
  });
});
