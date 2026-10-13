/**
 * `canvas.open` finds the file it is asked for: by id, or by name — the
 * newest in this conversation first, then the library — and refuses a name
 * the library has twice, listing the candidates, and a file that is not there.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, ensureOwner, migrate, saveArtifact, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { canvasOpen } from './canvas.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_canvas_open_test_${process.pid}`;

suite('canvas.open', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  let here: string;
  let elsewhere: string;
  const ctx = (conversationId?: string): CoreToolContext => ({
    db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC', agentId: 'scout', ...(conversationId ? { conversationId } : {}),
  });
  const file = async (text: string, filename: string, conversationId: string | null, mime = 'text/markdown'): Promise<string> =>
    (await saveArtifact(pool, { bytes: Buffer.from(text), mime, filename, createdBy: 'scout', conversationId }, { BUDDI_DATA_DIR: dir })).id;
  const open = (input: unknown, conversationId?: string) => canvasOpen.execute(canvasOpen.input!.parse(input), ctx(conversationId));

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    here = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id;
    elsewhere = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id;
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-canvas-open-'));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('opens a file by id, saying its name and type', async () => {
    const id = await file('# Packing\n', 'packing-list.md', here);
    expect(await open({ artifactId: id }, here)).toEqual({ opened: true, artifactId: id, filename: 'packing-list.md', mime: 'text/markdown' });
  });

  it('opens a name: this conversation’s newest first, else the library’s only one', async () => {
    await file('# Old\n', 'trip.md', here);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newest = await file('# New\n', 'trip.md', here);
    await file('# Other\n', 'trip.md', elsewhere);
    expect((await open({ name: 'Trip.md' }, here)).artifactId).toBe(newest);
    const only = await file('a,b\n', 'budget.csv', elsewhere, 'text/csv');
    expect((await open({ name: 'budget.csv' }, here)).artifactId).toBe(only);
  });

  it('refuses a name the library has twice, listing them, and a file that is not there', async () => {
    const a = await file('# A\n', 'notes.md', elsewhere);
    const b = await file('# B\n', 'notes.md', null);
    const refused = open({ name: 'notes.md' }, here);
    await expect(refused).rejects.toThrow(/More than one file in Files is called "notes.md"/);
    await expect(open({ name: 'notes.md' }, here)).rejects.toThrow(new RegExp(`${a}.*|${b}.*`));
    await expect(open({ name: 'nothing.md' }, here)).rejects.toThrow(/No file called "nothing.md"/);
    await expect(open({ artifactId: '11111111-1111-4111-8111-111111111111' }, here)).rejects.toThrow(/There is no file/);
    expect(() => canvasOpen.input!.parse({ artifactId: a, name: 'notes.md' })).toThrow(/exactly one/);
    expect(() => canvasOpen.input!.parse({})).toThrow(/exactly one/);
  });

  it('says a deleted file was deleted', async () => {
    const id = await file('# Gone\n', 'gone.md', here);
    await pool.query('update core.artifacts set deleted_at = now() where id = $1', [id]);
    await expect(open({ artifactId: id }, here)).rejects.toThrow(/was deleted from Files by the owner/);
  });
});
