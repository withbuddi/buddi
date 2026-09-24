/**
 * 042: files saved before the plugin host are attributed to the plugin their
 * provenance names, once, and nothing else is. Runs on a database of its own,
 * named after this process and dropped.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, createPool, migrateCore } from '../db.js';
import { urlForDatabase } from '../backup/restore.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_backfill_${process.pid}`;
const BACKFILL = readFileSync(path.join(CORE_MIGRATIONS_DIR, '042_plugin_files_backfill.sql'), 'utf8');

suite('042: the plugin_files backfill', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${DB}"`);
    await admin?.end();
  });

  async function artifact(over: Record<string, unknown>): Promise<string> {
    const row = {
      kind: 'other',
      mime: 'application/octet-stream',
      filename: null,
      source_surface: null,
      source_chat_id: null,
      caption: null,
      created_by: 'assistant',
      ...over,
    };
    const { rows } = await pool.query(
      `insert into core.artifacts (kind, mime, filename, size_bytes, sha256, storage_path, source_surface, source_chat_id, caption, created_by)
       values ($1, $2, $3, 1, md5(random()::text), 'x', $4, $5, $6, $7) returning id`,
      [row.kind, row.mime, row.filename, row.source_surface, row.source_chat_id, row.caption, row.created_by],
    );
    return String(rows[0].id);
  }

  it('attributes by surface, by a plugin\'s own reference and by the screenshot shape, and only once', async () => {
    const attachment = await artifact({ source_surface: 'email', filename: 'invoice.pdf' });
    const returned = await artifact({ source_surface: 'host', filename: 'out.txt' });
    const draft = await artifact({ mime: 'text/plain', filename: 'draft.txt', caption: 'Re: lunch' });
    const shot = await artifact({
      kind: 'image',
      mime: 'image/png',
      filename: 'web-5173-home.png',
      caption: 'web at / (port 5173), 1280×800',
    });
    const upload = await artifact({ source_surface: 'telegram', source_chat_id: '42', created_by: 'owner' });
    const made = await artifact({ kind: 'image', mime: 'image/png', filename: 'cat.png', caption: 'a cat' });

    await pool.query(`create schema if not exists email`);
    await pool.query(`create table email.drafts (id uuid primary key default gen_random_uuid(), artifact_id uuid null)`);
    await pool.query(`insert into email.drafts (artifact_id) values ($1), (null)`, [draft]);

    await pool.query(BACKFILL);
    await pool.query(BACKFILL);

    const { rows } = await pool.query(`select plugin, artifact_id::text as id from core.plugin_files order by plugin, artifact_id`);
    const owners = new Map(rows.map((r: { plugin: string; id: string }) => [r.id, r.plugin]));
    expect(owners.get(attachment)).toBe('email');
    expect(owners.get(draft)).toBe('email');
    expect(owners.get(returned)).toBe('host');
    expect(owners.get(shot)).toBe('developer');
    expect(owners.has(upload)).toBe(false);
    expect(owners.has(made)).toBe(false);
    expect(rows).toHaveLength(4);
  });
});
