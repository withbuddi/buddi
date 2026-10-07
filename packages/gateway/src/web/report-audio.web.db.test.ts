import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, ensureOwner, migrate, saveArtifact, ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { createApiToken } from './api-tokens.js';
import { startWebServer, type WebServer } from './server.js';
const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_report_audio_test_${process.pid}`;
const emptyCatalog = (): AgentCatalog => ({ get: () => undefined, byHandle: () => undefined, list: () => [], agentsWithRole: () => [], defaultAgent: () => undefined, resolve: () => undefined }) as unknown as AgentCatalog;
suite('saved report audio', () => {
  let admin: Pool, pool: Pool, web: WebServer;
  let base: string, dir: string, token: string, audioId: string;
  const link = '#/p/news/stories?edition=e_evening';
  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-export-'));
    const env = { ...process.env, BUDDI_DATA_DIR: dir };
    audioId = (await saveArtifact(pool, { bytes: Buffer.from('recording'), mime: 'audio/ogg', filename: 'edition.ogg', createdBy: 'anchor' }, env)).id;
    await pool.query(`insert into core.owner_notifications (kind, urgency, title, state, link, audio) values ('plugin', 'today', 'Edition', 'shown', $1, $2)`, [link, audioId]);
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


  const get = (route: string, auth = true) => fetch(`${base}/api/reports/audio?link=${encodeURIComponent(route)}`, auth ? { headers: { authorization: `Bearer ${token}` } } : {});
  it('returns the exact edition recording and never another edition recording', async () => {
    const response = await get(link);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ audio: { fileId: audioId, mime: 'audio/ogg', filename: 'edition.ogg', sizeBytes: 9 } });
    expect(await (await get('#/p/news/stories?edition=e_other')).json()).toEqual({ audio: null });
  });
  it('requires authentication and a local report link', async () => {
    expect((await get(link, false)).status).toBe(401);
    expect((await get('https://example.com')).status).toBe(400);
  });
});
