/**
 * The artifact tools against a real database. Skipped unless DATABASE_URL is
 * set; when it runs it creates a throwaway database and a throwaway data dir,
 * and never touches the owner's own.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, migrateCore, saveArtifact } from '@buddi/core/testing';
import type { CoreToolContext } from '@buddi/core/testing';
import { manifest } from '../index.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_artifact_tools_test_${process.pid}`;

suite('artifacts tools (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let previousDataDir: string | undefined;
  const registry = new ToolRegistry();

  const ctx = (): CoreToolContext => ({
    db: pool,
    ownerId: 'test',
    now: () => new Date('2026-09-13T12:00:00Z'),
    timezone: 'UTC',
    agentId: 'finance-advisor',
  });

  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await registry.invoke(name, args, ctx());
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  let textId = '';
  let imageId = '';

  beforeAll(async () => {
    registry.register(manifest);
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    pool = createPool((databaseUrl as string).replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`));
    await migrateCore(pool);

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-artifact-tools-'));
    // The tools read the data dir from the ambient environment, the same way
    // the running process does; the test points it somewhere disposable.
    previousDataDir = process.env.BUDDI_DATA_DIR;
    process.env.BUDDI_DATA_DIR = dataDir;

    const statement = await saveArtifact(pool, {
      bytes: Buffer.from('BUDDI TEST STATEMENT\n\n\nClosing balance 987.65\n', 'utf8'),
      mime: 'text/plain',
      filename: 'august.txt',
      caption: 'august statement',
      createdBy: 'owner',
      source: { surface: 'telegram', chatId: '42' },
    });
    textId = statement.id;

    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(300, 16);
    png.writeUInt32BE(200, 20);
    const photo = await saveArtifact(pool, {
      bytes: png,
      mime: 'image/png',
      filename: 'receipt.png',
      createdBy: 'owner',
    });
    imageId = photo.id;
  }, 60_000); // a fresh schema plus fixtures: under the whole gate's load the default 10 s was flaky

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (previousDataDir === undefined) delete process.env.BUDDI_DATA_DIR;
    else process.env.BUDDI_DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('registers three auto-tier tools and no migrations', () => {
    expect(manifest.migrationsDir).toBe('');
    const specs = registry.list().filter((s) => s.name.startsWith('artifacts.'));
    expect(specs.map((s) => s.name)).toEqual([
      'artifacts.list',
      'artifacts.describe',
      'artifacts.text',
    ]);
    expect(specs.every((s) => s.tier === 'auto')).toBe(true);
  });

  it('lists metadata only — never the bytes', async () => {
    const out = await call('artifacts.list', { limit: 10 });
    expect(out.count).toBe(2);
    const first = out.artifacts[0];
    expect(Object.keys(first).sort()).toEqual(
      ['caption', 'createdAt', 'filename', 'id', 'kind', 'mime', 'sizeBytes'].sort(),
    );
    const images = await call('artifacts.list', { kind: 'image' });
    expect(images.artifacts.map((a: any) => a.id)).toEqual([imageId]);
  });

  it('describes a text artifact with its extracted text', async () => {
    const out = await call('artifacts.describe', { id: textId });
    expect(out.filename).toBe('august.txt');
    expect(out.caption).toBe('august statement');
    expect(out.text).toBe('BUDDI TEST STATEMENT\n\nClosing balance 987.65');
    expect(out.truncated).toBe(false);
  });

  it('describes an image with its pixel size and no text', async () => {
    const out = await call('artifacts.describe', { id: imageId });
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    expect(out.text).toBeUndefined();
    expect(out.note).toMatch(/shown to you directly/);
  });

  it('returns the full text, and refuses a type it cannot read', async () => {
    const out = await call('artifacts.text', { id: textId });
    expect(out.text).toContain('Closing balance 987.65');
    expect(out.truncated).toBe(false);
    expect(out.chars).toBe(out.text.length);

    const refused = await registry.invoke('artifacts.text', { id: imageId }, ctx());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/image\/png/);
  });

  it('refuses an unknown id with something the model can act on', async () => {
    const missing = await registry.invoke(
      'artifacts.describe',
      { id: '11111111-1111-4111-8111-111111111111' },
      ctx(),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/artifacts.list/);
  });

  it('refuses an id that is not a uuid before touching the database', async () => {
    const bad = await registry.invoke('artifacts.describe', { id: 'august.pdf' }, ctx());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid-args');
  });
});
