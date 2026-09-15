/**
 * Artifact store. The pure parts run everywhere; the store itself needs a
 * database, so that suite is skipped unless DATABASE_URL is set — and when it
 * runs it uses a throwaway database and a throwaway data dir, never the
 * developer's own.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from '../db.js';
import {
  deleteArtifact,
  extensionFor,
  getArtifact,
  kindForMime,
  listArtifacts,
  readArtifactBytes,
  resolveDataDir,
  saveArtifact,
  sha256Of,
  storagePathFor,
} from './store.js';
import { testDatabaseUrl } from '../testing/database-url.js';

describe('kindForMime', () => {
  it('derives the kind from the media type, never from the sender', () => {
    expect(kindForMime('image/png')).toBe('image');
    expect(kindForMime('IMAGE/JPEG')).toBe('image');
    expect(kindForMime('audio/ogg')).toBe('audio');
    expect(kindForMime('application/pdf')).toBe('document');
    expect(kindForMime('text/csv; charset=utf-8')).toBe('document');
    expect(kindForMime('video/mp4')).toBe('other');
    expect(kindForMime('application/octet-stream')).toBe('other');
  });
});

describe('extensionFor', () => {
  it('prefers the media type, falls back to the filename, then to .bin', () => {
    expect(extensionFor('application/pdf')).toBe('pdf');
    expect(extensionFor('image/jpeg', 'photo.png')).toBe('jpg');
    expect(extensionFor('application/x-weird', 'notes.md')).toBe('md');
    expect(extensionFor('application/octet-stream')).toBe('bin');
  });

  it('never takes a path or a dotfile trick out of the filename', () => {
    expect(extensionFor('application/x-weird', '../../etc/passwd')).toBe('bin');
    expect(extensionFor('application/x-weird', 'archive.tar.gz')).toBe('gz');
  });
});

describe('storagePathFor', () => {
  it('shards by year and month and names the file by its hash', () => {
    const at = new Date('2026-09-13T22:00:00Z');
    expect(storagePathFor('abc123', 'application/pdf', 'august.pdf', at)).toBe(
      'artifacts/2026/09/abc123.pdf',
    );
  });
});

describe('resolveDataDir', () => {
  it('honours BUDDI_DATA_DIR and falls back to <repo>/data', () => {
    expect(resolveDataDir({ BUDDI_DATA_DIR: '/tmp/buddi-data' })).toBe('/tmp/buddi-data');
    expect(resolveDataDir({})).toMatch(/[/\\]data$/);
  });
});

/* ---------------- postgres-backed ---------------- */

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_artifacts_test_${process.pid}`;

suite('artifact store (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    pool = createPool((databaseUrl as string).replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`));
    await migrateCore(pool);
    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-artifacts-'));
    env = { BUDDI_DATA_DIR: dataDir };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

  it('writes the bytes to the data dir and records the metadata', async () => {
    const body = bytes('closing balance 987.65');
    const row = await saveArtifact(
      pool,
      {
        bytes: body,
        mime: 'application/pdf',
        filename: 'august.pdf',
        caption: 'my statement',
        createdBy: 'owner',
        source: { surface: 'telegram', chatId: '42', messageId: '7' },
      },
      env,
    );

    expect(row.kind).toBe('document');
    expect(row.sizeBytes).toBe(body.length);
    expect(row.sha256).toBe(sha256Of(body));
    expect(row.storagePath).toMatch(/^artifacts\/\d{4}\/\d{2}\/[0-9a-f]{64}\.pdf$/);
    expect(row.caption).toBe('my statement');

    const onDisk = await readFile(path.join(dataDir, row.storagePath));
    expect(onDisk.equals(body)).toBe(true);
    expect((await readArtifactBytes(env, row)).equals(body)).toBe(true);
  });

  it('returns the existing row when the same file arrives twice in one chat', async () => {
    const body = bytes('the very same bytes');
    const source = { surface: 'telegram', chatId: '42', messageId: '8' };
    const first = await saveArtifact(
      pool,
      { bytes: body, mime: 'image/png', createdBy: 'owner', source },
      env,
    );
    const again = await saveArtifact(
      pool,
      { bytes: body, mime: 'image/png', createdBy: 'owner', source: { ...source, messageId: '9' } },
      env,
    );
    expect(again.id).toBe(first.id);
  });

  it('keeps the same bytes from two different chats apart', async () => {
    const body = bytes('forwarded everywhere');
    const a = await saveArtifact(
      pool,
      { bytes: body, mime: 'image/png', createdBy: 'owner', source: { surface: 'telegram', chatId: '1' } },
      env,
    );
    const b = await saveArtifact(
      pool,
      { bytes: body, mime: 'image/png', createdBy: 'owner', source: { surface: 'telegram', chatId: '2' } },
      env,
    );
    expect(b.id).not.toBe(a.id);
    expect(b.sha256).toBe(a.sha256);
  });

  it('dedups source-less artifacts too, where Postgres would not', async () => {
    // NULLs are distinct to a unique constraint, so this case is matched in code.
    const body = bytes('an agent wrote this');
    const first = await saveArtifact(
      pool,
      { bytes: body, mime: 'text/plain', createdBy: 'finance-advisor' },
      env,
    );
    const again = await saveArtifact(
      pool,
      { bytes: body, mime: 'text/plain', createdBy: 'finance-advisor' },
      env,
    );
    expect(again.id).toBe(first.id);
  });

  it('lists newest first, filters by kind, and hides deleted rows', async () => {
    const row = await saveArtifact(
      pool,
      { bytes: bytes('listed once'), mime: 'audio/ogg', createdBy: 'owner' },
      env,
    );
    const audio = await listArtifacts(pool, { kind: 'audio', limit: 10 });
    expect(audio.map((a) => a.id)).toContain(row.id);

    expect(await deleteArtifact(pool, row.id)).toBe(true);
    expect(await deleteArtifact(pool, row.id)).toBe(false);
    expect(await getArtifact(pool, row.id)).toBeNull();
    const after = await listArtifacts(pool, { kind: 'audio', limit: 10 });
    expect(after.map((a) => a.id)).not.toContain(row.id);
  });

  it('names the artifact when its bytes have gone missing', async () => {
    const row = await saveArtifact(
      pool,
      { bytes: bytes('about to vanish'), mime: 'text/plain', createdBy: 'owner' },
      env,
    );
    await rm(path.join(dataDir, row.storagePath));
    await expect(readArtifactBytes(env, row)).rejects.toThrow(row.id);
  });

  it('refuses empty bytes and a missing creator', async () => {
    await expect(
      saveArtifact(pool, { bytes: Buffer.alloc(0), mime: 'text/plain', createdBy: 'owner' }, env),
    ).rejects.toThrow(/non-empty Buffer/);
    await expect(
      saveArtifact(pool, { bytes: bytes('x'), mime: 'text/plain', createdBy: '  ' }, env),
    ).rejects.toThrow(/createdBy/);
  });

  it('reuses a file that is already on disk without corrupting it', async () => {
    // Content addressing means a path collision is a byte-identical file.
    const body = bytes('written twice, identical');
    const at = new Date();
    const relative = storagePathFor(sha256Of(body), 'text/plain', null, at);
    const absolute = path.join(dataDir, relative);
    await writeFile(absolute, body).catch(async () => {
      /* directory may not exist yet — saveArtifact creates it */
    });
    const row = await saveArtifact(
      pool,
      { bytes: body, mime: 'text/plain', createdBy: 'owner', source: { surface: 'cli' } },
      env,
    );
    expect((await readArtifactBytes(env, row)).equals(body)).toBe(true);
  });
});
