/**
 * GET /api/artifacts/:id/export/:format — each format parsed back, and the
 * refusals: a format the file does not offer, a file that is not there, and
 * no credential. Authenticated with an API token, the scripted door.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { Pool } from 'pg';
import { readSheet } from 'read-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, ensureOwner, migrate, saveArtifact, ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { extractText } from '@buddi/tool-artifacts';
import { createApiToken } from './api-tokens.js';
import { startWebServer, type WebServer } from './server.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_export_web_test_${process.pid}`;

const emptyCatalog = (): AgentCatalog =>
  ({ get: () => undefined, byHandle: () => undefined, list: () => [], agentsWithRole: () => [], defaultAgent: () => undefined, resolve: () => undefined }) as unknown as AgentCatalog;

suite('document export route', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let base: string;
  let dir: string;
  let token: string;
  let mdId: string;
  let csvId: string;
  let pngId: string;

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
    mdId = (await saveArtifact(pool, { bytes: Buffer.from('# Quarterly review\n\n- Revenue **up**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'), mime: 'text/markdown', filename: 'Quarterly review (v2).md', createdBy: 'researcher' }, env)).id;
    csvId = (await saveArtifact(pool, { bytes: Buffer.from('Item,Amount\r\nRent,1200\r\n'), mime: 'text/csv', filename: 'Budget.csv', createdBy: 'cfo' }, env)).id;
    pngId = (await saveArtifact(pool, { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=', 'base64'), mime: 'image/png', filename: 'a.png', createdBy: 'owner' }, env)).id;
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

  const get = (id: string, format: string, auth = true): Promise<Response> =>
    fetch(`${base}/api/artifacts/${id}/export/${format}`, auth ? { headers: { authorization: `Bearer ${token}` } } : {});

  it('converts Markdown to a PDF that reads back, named after the file', async () => {
    const res = await get(mdId, 'pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('Quarterly review (v2).pdf')}`);
    const { text } = await extractText(Buffer.from(await res.arrayBuffer()), 'application/pdf', 10_000);
    expect(text).toContain('Quarterly review');
    expect(text).toContain('Revenue up');
  }, 30_000);

  it('converts Markdown to Word', async () => {
    const res = await get(mdId, 'docx');
    expect(res.status).toBe(200);
    const xml = strFromU8(unzipSync(new Uint8Array(await res.arrayBuffer()))['word/document.xml']!);
    expect(xml).toContain('Quarterly review');
    expect(xml).toContain('<w:tbl>');
  });

  it('hands Markdown back as Markdown, and a table as Excel or CSV', async () => {
    expect(await (await get(mdId, 'md')).text()).toContain('# Quarterly review');
    const xlsx = await get(csvId, 'xlsx');
    expect(xlsx.status).toBe(200);
    expect(await readSheet(Buffer.from(await xlsx.arrayBuffer()))).toEqual([['Item', 'Amount'], ['Rent', 1200]]);
    expect(await (await get(csvId, 'csv')).text()).toBe('Item,Amount\r\nRent,1200\r\n');
  });

  it('refuses what a file does not offer, a missing file, and no credential', async () => {
    expect((await get(mdId, 'xlsx')).status).toBe(415);
    expect((await get(csvId, 'pdf')).status).toBe(415);
    expect((await get(pngId, 'pdf')).status).toBe(415);
    expect((await get(mdId, 'exe')).status).toBe(415);
    expect((await get('11111111-1111-4111-8111-111111111111', 'pdf')).status).toBe(404);
    expect((await get(mdId, 'pdf', false)).status).toBe(401);
  });
});
