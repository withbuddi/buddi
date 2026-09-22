/**
 * "A query cannot write", proved against a real Postgres.
 *
 * The first version of this guard was a keyword scanner, and a scanner cannot
 * decide whether a statement writes: `select * into evil from t` is
 * `create table as` in disguise, and `select plugin.f()` is opaque — the
 * function can insert whatever it likes. So the enforcement moved to Postgres
 * (a `read only` transaction), and this suite is the reason to believe it:
 * every statement below is one the scanner would have waved through.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './db.js';
import { readOnlyPool, ReadOnlyRefusal } from './pages.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_pages_ro_test_${process.pid}`;

suite('the pool a page query is handed', () => {
  let admin: Pool;
  let pool: Pool;
  let reader: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    // A table whose columns are named after keywords the old scanner refused,
    // a sequence, and a volatile function that writes — the three shapes.
    await pool.query('create table things (id int primary key, comment text, copy text, "set" text)');
    await pool.query("insert into things values (1, 'a note', 'a copy', 'a set')");
    await pool.query('create sequence things_seq');
    await pool.query(`
      create function sneak() returns int language plpgsql volatile as $$
      begin
        insert into things values (99, 'snuck', '', '');
        return 99;
      end $$`);
    reader = readOnlyPool(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('answers an ordinary read, whatever its columns are called', async () => {
    const rows = await reader.query<{ comment: string }>('select comment from things where id = $1', [1]);
    expect(rows.rows[0]?.comment).toBe('a note');
    const keywords = await reader.query('select copy, "set" from things');
    expect(keywords.rows).toHaveLength(1);
  });

  it('refuses `select … into`, which is a table being created', async () => {
    await expect(reader.query('select * into evil from things')).rejects.toThrow();
    const left = await pool.query("select to_regclass('evil') as t");
    expect(left.rows[0]?.t).toBeNull();
  });

  it('refuses a volatile function that writes — the case no scanner can see', async () => {
    await expect(reader.query('select sneak()')).rejects.toThrow(/read-only transaction/i);
    const after = await pool.query('select count(*)::int as n from things');
    expect(after.rows[0]?.n).toBe(1);
  });

  it('refuses a sequence being moved', async () => {
    await expect(reader.query("select nextval('things_seq')")).rejects.toThrow(/read-only transaction/i);
    await expect(reader.query("select setval('things_seq', 10)")).rejects.toThrow();
  });

  it('refuses a large object being created from a file', async () => {
    await expect(reader.query("select lo_import('/etc/passwd')")).rejects.toThrow();
  });

  it('leaves nothing behind: the transaction is rolled back either way', async () => {
    await reader.query('select 1');
    const idle = await pool.query(
      "select count(*)::int as n from pg_stat_activity where state = 'idle in transaction' and datname = current_database()",
    );
    expect(idle.rows[0]?.n).toBe(0);
  });

  it('still refuses what the pre-filter can see, without spending a connection', async () => {
    await expect(reader.query('update things set comment = null')).rejects.toThrow(ReadOnlyRefusal);
    await expect(reader.query('select 1; update things set comment = null')).rejects.toThrow(ReadOnlyRefusal);
  });
});
