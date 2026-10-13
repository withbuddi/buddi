/**
 * `canvas.open` opens the file it is asked for, by id only — the file's, or
 * any version's — at its current version, and refuses a file that is gone or
 * was never there. (A name could pick the wrong file: an older version, or
 * one of two outputs that share a basename.)
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, deleteFile, ensureOwner, migrate, saveArtifact, saveVersion, type CoreToolContext } from '@buddi/core';
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
  const ctx = (conversationId?: string): CoreToolContext => ({
    db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC', agentId: 'scout', ...(conversationId ? { conversationId } : {}),
  });
  const file = async (text: string, filename: string, conversationId: string | null, mime = 'text/markdown'): Promise<{ fileId: string; artifactId: string }> => {
    const row = await saveArtifact(pool, { bytes: Buffer.from(text), mime, filename, createdBy: 'scout', conversationId }, { BUDDI_DATA_DIR: dir });
    return { fileId: row.fileId, artifactId: row.id };
  };
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
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-canvas-open-'));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('opens a file by id at its current version, saying its name and type', async () => {
    const made = await file('# Packing\n', 'packing-list.md', here);
    expect(await open({ fileId: made.fileId }, here)).toEqual({
      opened: true, fileId: made.fileId, artifactId: made.artifactId, version: 1, filename: 'packing-list.md', mime: 'text/markdown',
      note: 'Open at v1, its newest version.',
    });
  });

  it('opens the newest version whichever version’s id it is given', async () => {
    // Codex P2: by name it opened "Plan.md" when "Plan (v2).md" was newer.
    const made = await file('# Plan\n', 'Plan.md', here);
    const v2 = await saveVersion(pool, { id: made.fileId, bytes: Buffer.from('# Plan, two\n'), createdBy: 'scout' }, { BUDDI_DATA_DIR: dir });
    expect(await open({ fileId: made.artifactId }, here)).toMatchObject({ fileId: made.fileId, artifactId: v2.row.id, version: 2, filename: 'Plan.md' });
  });

  it('takes no name, and refuses a file that is not there', async () => {
    expect(() => canvasOpen.input!.parse({ name: 'notes.md' })).toThrow();
    expect(() => canvasOpen.input!.parse({})).toThrow();
    await expect(open({ fileId: '11111111-1111-4111-8111-111111111111' }, here)).rejects.toThrow(/There is no file/);
  });

  it('says a deleted file was deleted', async () => {
    const made = await file('# Gone\n', 'gone.md', here);
    await deleteFile(pool, made.fileId);
    await expect(open({ fileId: made.fileId }, here)).rejects.toThrow(/was deleted from Files by the owner/);
  });
});
