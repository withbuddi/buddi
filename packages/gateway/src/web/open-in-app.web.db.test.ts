/**
 * Open in app (web/open-in-app.ts) over the wire: the newest version of a
 * Word file exported to a working copy the server names, handed to the
 * owner's app (a stand-in here), a save there brought back as his version
 * through the one owner save, a save refused because buddi wrote a newer
 * version meanwhile — Keep mine and Show theirs — and the limits: this
 * computer only, the copy always under `<data>/open/<fileId>/`, never
 * through a link, never an app's lock file.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CORE_MIGRATIONS_DIR, CORE_SCHEMA, OFFICE_MIME, ToolRegistry, createPool, ensureOwner, migrate, saveArtifact, saveVersion,
  type AgentCatalog, type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { hostFetch } from '../__fixtures__/host-fetch.js';
import { csrfCookieName } from './http.js';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_open_in_app_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const catalog = { get: () => undefined, list: () => [], byHandle: () => undefined, agentsWithRole: () => [], resolve: () => undefined } as unknown as AgentCatalog;

suite('Open in app', () => {
  let admin: Pool;
  let pool: Pool;
  let app: WebServer;
  let dir: string;
  let env: Record<string, string | undefined>;
  const launched: string[] = [];
  const base = (): string => `http://127.0.0.1:${app.port}`;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-open-in-app-')));
    env = { ...process.env, BUDDI_DATA_DIR: dir, BUDDI_VAULT: 'memory' };
    app = await startWebServer({
      pool, registry: new ToolRegistry(), catalog, timezone: 'UTC', now: () => new Date(), env,
      ctx: { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as CoreToolContext,
      config: { enabled: true, host: '127.0.0.1', port: 0 }, token: TOKEN, openAccess: true, log: () => {},
      // The owner's app is a stand-in; a save is imported at the first look after it.
      openInApp: { launch: async (file) => { launched.push(file); }, settleMs: 0, pollMs: 60_000 },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`drop database if exists ${TEST_DB}`);
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function caller(cookies: string[], extra: Record<string, string> = {}, origin = base()) {
    const csrf = cookies.find((c) => c.startsWith(`${csrfCookieName(app.port)}=`))?.split('=')[1] ?? '';
    return async (method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await hostFetch(`${base()}${route}`, {
        method,
        headers: { Cookie: cookies.join('; '), Connection: 'close', ...extra, ...(method === 'GET' ? {} : { Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  }

  async function local() {
    const res = await hostFetch(`${base()}/api/session`, { headers: { Connection: 'close' } });
    return caller(res.headers.getSetCookie().map((c) => c.split(';')[0]!));
  }

  async function remote() {
    const proxy = { 'X-Forwarded-For': '203.0.113.4', Host: 'buddi.tail1234.ts.net:9443' };
    const exchange = await hostFetch(`${base()}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { headers: { ...proxy, Connection: 'close' } });
    return caller(exchange.headers.getSetCookie().map((c) => c.split(';')[0]!), proxy, 'https://buddi.tail1234.ts.net:9443');
  }

  const word = async (name: string, bytes = Buffer.from(`docx ${name} ${Math.random()}`), createdBy = 'owner'): Promise<{ fileId: string; bytes: Buffer }> => {
    const row = await saveArtifact(pool, { bytes, mime: OFFICE_MIME.docx, filename: name, createdBy, source: { surface: 'telegram', chatId: '1' } }, env);
    return { fileId: row.fileId, bytes };
  };

  it('exports the newest version to a copy under the data folder and hands it to the app', async () => {
    const call = await local();
    const { fileId, bytes } = await word('Letter.docx');
    const opened = await call('POST', `/api/files/${fileId}/open`, {});
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ open: true, fileId, name: 'Letter.docx', base: 1 });
    const copy = path.join(dir, 'open', fileId, 'Letter.docx');
    expect(launched.at(-1)).toBe(copy);
    expect(await readFile(copy)).toEqual(bytes);
    // Open again: the same copy, launched again, nothing new in Files.
    expect((await call('POST', `/api/files/${fileId}/open`, {})).body).toMatchObject({ base: 1 });
    expect(launched.filter((f) => f === copy)).toHaveLength(2);
    expect((await call('GET', `/api/files/${fileId}/open`)).body).toMatchObject({ open: true, base: 1 });
    expect((await call('GET', `/api/files/${fileId}`)).body.versions).toHaveLength(1);
  });

  it('brings a save in the app back as the owner’s next version, never the app’s lock file', async () => {
    const call = await local();
    const { fileId } = await word('Plan.docx', Buffer.from('plan v1'), 'writer');
    await call('POST', `/api/files/${fileId}/open`, {});
    const copy = path.join(dir, 'open', fileId, 'Plan.docx');
    // Word's lock file beside it: never imported.
    await writeFile(path.join(dir, 'open', fileId, '~$Plan.docx'), 'owner lock');
    await writeFile(copy, 'plan as saved in Word');
    const state = await call('GET', `/api/files/${fileId}/open`);
    expect(state.body).toMatchObject({ open: true, base: 2, savedVersion: 2 });
    const view = (await call('GET', `/api/files/${fileId}`)).body;
    expect(view.current).toMatchObject({ version: 2, createdBy: 'owner' });
    expect(view.versions).toHaveLength(2);
    // Looked at again with nothing new: no third version.
    await call('GET', `/api/files/${fileId}/open`);
    expect((await call('GET', `/api/files/${fileId}`)).body.versions).toHaveLength(2);
  });

  it('refuses a save over a newer version with the one conflict shape; Keep mine saves it over, Show theirs closes the copy', async () => {
    const call = await local();
    const { fileId } = await word('Budget.docx', Buffer.from('budget v1'), 'writer');
    await call('POST', `/api/files/${fileId}/open`, {});
    const copy = path.join(dir, 'open', fileId, 'Budget.docx');
    // buddi writes v2 meanwhile.
    await saveVersion(pool, { id: fileId, bytes: Buffer.from('budget v2 by buddi'), createdBy: 'writer' }, env);
    await writeFile(copy, 'budget as the owner saved it');
    const refused = await call('GET', `/api/files/${fileId}/open`);
    expect(refused.body).toMatchObject({ open: true, base: 1, conflict: 'newer', current: { version: 2, createdBy: 'writer' } });
    expect(refused.body.error).toMatch(/This file changed since you opened it: v2 is newer/);
    expect((await call('GET', `/api/files/${fileId}`)).body.versions).toHaveLength(2);
    // The same refused bytes are not tried again at every look.
    expect((await call('GET', `/api/files/${fileId}/open`)).body.conflict).toBe('newer');

    const mine = await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'mine' });
    expect(mine.body).toMatchObject({ open: true, base: 3, savedVersion: 3 });
    expect(mine.body.conflict).toBeUndefined();
    const view = (await call('GET', `/api/files/${fileId}`)).body;
    expect(view.current).toMatchObject({ version: 3, createdBy: 'owner' });

    // Again, and this time theirs: the copy goes, buddi's version stays the newest.
    await saveVersion(pool, { id: fileId, bytes: Buffer.from('budget v4 by buddi'), createdBy: 'writer', readVersion: 3 }, env);
    await writeFile(copy, 'budget saved again in Word');
    expect((await call('GET', `/api/files/${fileId}/open`)).body).toMatchObject({ conflict: 'newer', current: { version: 4 } });
    expect((await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'theirs' })).body).toEqual({ open: false, closed: true });
    await expect(stat(path.join(dir, 'open', fileId))).rejects.toThrow();
    expect((await call('GET', `/api/files/${fileId}`)).body.current).toMatchObject({ version: 4, createdBy: 'writer' });
    expect((await call('GET', `/api/files/${fileId}/open`)).body).toEqual({ open: false });
  });

  it('is refused off this computer', async () => {
    const call = await remote();
    const { fileId } = await word('Remote.docx');
    expect((await call('GET', '/api/session')).body).toMatchObject({ signedInThrough: 'ticket' });
    expect((await call('POST', `/api/files/${fileId}/open`, {})).status).toBe(403);
    expect((await call('GET', `/api/files/${fileId}/open`)).status).toBe(403);
    expect((await call('POST', `/api/files/${fileId}/open/resolve`, { keep: 'mine' })).status).toBe(403);
    await expect(stat(path.join(dir, 'open', fileId))).rejects.toThrow();
  });

  it('keeps the copy under open/<fileId>, whatever the file is called, and never writes through a link', async () => {
    const call = await local();
    const sneaky = await word('../../../escape.docx');
    const opened = await call('POST', `/api/files/${sneaky.fileId}/open`, {});
    expect(opened.status).toBe(200);
    expect(launched.at(-1)).toBe(path.join(dir, 'open', sneaky.fileId, 'escape.docx'));
    await expect(stat(path.join(dir, '..', 'escape.docx'))).rejects.toThrow();

    // Its folder swapped for a link elsewhere: nothing is written there.
    const linked = await word('Linked.docx');
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'buddi-open-elsewhere-'));
    await mkdir(path.join(dir, 'open'), { recursive: true });
    await symlink(elsewhere, path.join(dir, 'open', linked.fileId));
    const refused = await call('POST', `/api/files/${linked.fileId}/open`, {});
    expect(refused.status).toBe(409);
    await expect(stat(path.join(elsewhere, 'Linked.docx'))).rejects.toThrow();
    await rm(elsewhere, { recursive: true, force: true });

    // Only an Office document, and only a file in Files.
    const text = await saveArtifact(pool, { bytes: Buffer.from('# notes'), mime: 'text/markdown', filename: 'notes.md', createdBy: 'writer' }, env);
    expect((await call('POST', `/api/files/${text.fileId}/open`, {})).status).toBe(415);
    expect((await call('POST', '/api/files/00000000-0000-4000-8000-000000000000/open', {})).status).toBe(404);
  });
});
