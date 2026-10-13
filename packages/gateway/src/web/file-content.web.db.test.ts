/**
 * GET and PUT /api/artifacts/:id/content — the canvas editor's routes. A save
 * names the version it edited; a stale one is a 409 with the version that
 * won, whether the bytes changed or the agent wrote a newer version under the
 * same name. Nothing in a request is a path: what is written lands under the
 * data dir, at the place its hash gives.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, ensureOwner, getArtifact, migrate, saveArtifact, ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { createApiToken } from './api-tokens.js';
import { startWebServer, type WebServer } from './server.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_file_content_test_${process.pid}`;

const emptyCatalog = (): AgentCatalog =>
  ({ get: () => undefined, byHandle: () => undefined, list: () => [], agentsWithRole: () => [], defaultAgent: () => undefined, resolve: () => undefined }) as unknown as AgentCatalog;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

suite('file content routes', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let base: string;
  let dir: string;
  let token: string;
  let env: Record<string, string | undefined>;
  let conversationId: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    conversationId = (await pool.query("insert into core.conversations (agent_id) values ('scout') returning id")).rows[0].id;
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-file-content-'));
    env = { ...process.env, BUDDI_DATA_DIR: dir };
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    web = await startWebServer({
      pool, registry: new ToolRegistry(), catalog: emptyCatalog(), ctx, timezone: 'UTC', now: () => new Date(), env,
      config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'a-test-dashboard-token-long-enough', openAccess: false, log: () => {},
    });
    base = `http://127.0.0.1:${web.port}`;
    token = (await createApiToken(pool, { name: 'script', via: 'cli' })).token;
  }, 60_000);

  afterAll(async () => {
    await web?.close();
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const read = (id: string): Promise<Response> =>
    fetch(`${base}/api/artifacts/${id}/content`, { headers: { authorization: `Bearer ${token}` } });
  const save = (id: string, body: unknown): Promise<Response> =>
    fetch(`${base}/api/artifacts/${id}/content`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const file = async (text: string, filename: string, mime = 'text/markdown', conversation: string | null = conversationId): Promise<string> =>
    (await saveArtifact(pool, { bytes: Buffer.from(text), mime, filename, createdBy: 'scout', conversationId: conversation }, env)).id;

  it('reads a text file whole, with the hash a save names', async () => {
    const id = await file('# Plan\n\nOne\n', 'Plan.md');
    const res = await read(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '# Plan\n\nOne\n', sha256: sha('# Plan\n\nOne\n'), sizeBytes: 12, editable: true, truncated: false });
  });

  it('saves over the version opened, and refuses a save against an older one with the version that won', async () => {
    const id = await file('alpha\n', 'notes.txt', 'text/plain');
    const first = await save(id, { text: 'alpha\nbeta\n', base: sha('alpha\n') });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ sha256: sha('alpha\nbeta\n'), sizeBytes: 11 });
    expect(await (await read(id)).json()).toMatchObject({ text: 'alpha\nbeta\n' });

    // A second tab still holding "alpha": stale.
    const stale = await save(id, { text: 'alpha\ngamma\n', base: sha('alpha\n') });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current: { artifactId: id, sha256: sha('alpha\nbeta\n'), filename: 'notes.txt' } });
    expect(await (await read(id)).json()).toMatchObject({ text: 'alpha\nbeta\n' });
  });

  it('is stale when the agent wrote a newer version under the same name', async () => {
    const v1 = await file('# Report\n\nDraft\n', 'Report.md');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const v2 = await file('# Report\n\nFinal\n', 'Report (v2).md');
    const res = await save(v1, { text: '# Report\n\nMine\n', base: sha('# Report\n\nDraft\n') });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ current: { artifactId: v2, sha256: sha('# Report\n\nFinal\n') } });
    // Keeping his own then saves onto the newest.
    expect((await save(v2, { text: '# Report\n\nMine\n', base: sha('# Report\n\nFinal\n') })).status).toBe(200);
  });

  it('writes only under the data dir, at the place the hash gives', async () => {
    const id = await file('x = 1\n', 'calc.py', 'text/x-python');
    expect((await save(id, { text: 'x = 2\n', base: sha('x = 1\n') })).status).toBe(200);
    const row = await getArtifact(pool, id);
    expect(row!.storagePath).toMatch(new RegExp(`^artifacts/\\d{4}/\\d{2}/${sha('x = 2\n')}\\.`));
    expect(await readFile(path.join(dir, row!.storagePath), 'utf8')).toBe('x = 2\n');
  });

  it('refuses what is not a text file in Files, and anything that looks like a path', async () => {
    const png = await file('not really a png', 'a.png', 'image/png', null);
    expect((await read(png)).status).toBe(415);
    expect((await save(png, { text: 'x', base: sha('not really a png') })).status).toBe(415);
    expect((await read('11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await save('11111111-1111-4111-8111-111111111111', { text: 'x', base: sha('x') })).status).toBe(404);
    for (const probe of ['..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fhosts', 'not-an-id']) {
      expect((await read(probe)).status).toBe(404);
      expect([404, 405]).toContain((await save(probe, { text: 'x', base: sha('x') })).status);
    }
    const id = await file('a\n', 'b.txt', 'text/plain');
    expect((await save(id, { text: 'b' })).status).toBe(400);
    expect((await save(id, { text: 'x'.repeat(1024 * 1024 + 1), base: sha('a\n') })).status).toBe(413);
  });

  it('opens a file past 1 MiB read-only, its start only', async () => {
    const big = 'line\n'.repeat(250_000);
    const id = await file(big, 'big.log', 'text/plain');
    const body = (await (await read(id)).json()) as { text: string; editable: boolean; truncated: boolean };
    expect(body.editable).toBe(false);
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBe(1024 * 1024);
  });
});
