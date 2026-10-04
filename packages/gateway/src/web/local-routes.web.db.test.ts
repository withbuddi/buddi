/**
 * The routes that are "this computer only" (docs/api.md), over the wire: the
 * command line tool, Remove buddi (plan, backup, job, removal) and Home's
 * passphrase card. A session signed in off this machine (a ticket exchanged
 * through a proxy) and an owner API token are refused; the card holds the
 * words back behind the PIN when one is set; and the generic job routes never
 * hand out an uninstall's job or a report's words.
 *
 * The supervisor is a socket that answers from fixtures and the vault is
 * in-memory: no keychain, no running buddi. Against a throwaway database
 * (the PIN and the API tokens live there); skipped unless DATABASE_URL is set.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, ensureOwner, migrate, ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hostFetch } from '../__fixtures__/host-fetch.js';
import { createApiToken } from './api-tokens.js';
import { csrfCookieName } from './http.js';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_local_routes_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const PHRASE = 'able acid actor adult afraid agent';
const UNINSTALL_JOB = '11111111-1111-4111-8111-111111111111';
const UPGRADE_JOB = '22222222-2222-4222-8222-222222222222';

const catalog = { get: () => undefined, list: () => [], byHandle: () => undefined, agentsWithRole: () => [], resolve: () => undefined } as unknown as AgentCatalog;

/** What the supervisor answers: an encrypted backup exists, the words, an uninstall job holding them, an upgrade job. */
function fakeSupervisor(socket: string): Server {
  return createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';
      if (url === '/backups') return res.end(JSON.stringify({ dir: '/d/backups', archives: [{ name: 'buddi-backup-20261004-030000.tar.gz.age', encrypted: true }] }));
      if (url === '/passphrase') return res.end(JSON.stringify({ passphrase: PHRASE }));
      if (url === '/uninstall' && req.method === 'GET') return res.end(JSON.stringify({ data: '/d', backups: '/h/buddi-backups', appFinishes: true }));
      if (url === `/jobs/${UNINSTALL_JOB}`) return res.end(JSON.stringify({ id: UNINSTALL_JOB, kind: 'uninstall-backup', phase: 'done', report: { archive: '/a.age', passphrase: PHRASE } }));
      if (url === `/jobs/${UPGRADE_JOB}`) return res.end(JSON.stringify({ id: UPGRADE_JOB, kind: 'upgrade', phase: 'done', report: { archive: '/pre.age', passphrase: PHRASE } }));
      if (url === '/cli') return res.end(JSON.stringify({ available: true, installed: [] }));
      res.statusCode = 202;
      res.end(JSON.stringify({ accepted: true }));
    });
  }).listen(socket);
}

/** Every local-only route, with a body for the writes. */
const LOCAL_ONLY: Array<[string, string, unknown?]> = [
  ['GET', '/api/system/cli'],
  ['POST', '/api/system/cli', {}],
  ['GET', '/api/system/uninstall'],
  ['POST', '/api/system/uninstall/backup', { token: 'x' }],
  ['GET', `/api/system/uninstall/jobs/${UNINSTALL_JOB}`],
  ['POST', '/api/system/uninstall', { token: 'x', wroteItDown: true }],
  ['GET', '/api/backups/passphrase/notice'],
];

suite('this computer only', () => {
  let admin: Pool;
  let pool: Pool;
  let app: WebServer;
  let supervisor: Server;
  let dir: string;
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
    dir = mkdtempSync(path.join(tmpdir(), 'buddi-local-'));
    const socket = path.join(dir, 's.sock');
    supervisor = fakeSupervisor(socket);
    app = await startWebServer({
      pool,
      registry: new ToolRegistry(),
      catalog,
      ctx: { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as unknown as CoreToolContext,
      timezone: 'UTC',
      now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      openAccess: true,
      log: () => {},
      env: { ...process.env, BUDDI_VAULT: 'memory', BUDDI_SUPERVISOR_SOCKET: socket },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => supervisor?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query("delete from core.web_settings where key in ('lock', 'lock.pin', 'backup.passphraseNotice')");
    await pool.query('truncate core.dashboard_sessions');
    await pool.query('delete from core.api_tokens');
  });

  /** A session: its cookies, and CSRF + Origin on every write. `extra` headers make it look remote. */
  function caller(cookies: string[], extra: Record<string, string> = {}, origin = base()) {
    const csrf = cookies.find((c) => c.startsWith(`${csrfCookieName(app.port)}=`))?.split('=')[1]
      ?? cookies.find((c) => c.includes('csrf'))?.split('=')[1] ?? '';
    return async (method: string, route: string, body?: unknown) => {
      const res = await hostFetch(`${base()}${route}`, {
        method,
        headers: { Cookie: cookies.join('; '), Connection: 'close', ...extra, ...(method === 'GET' ? {} : { Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
    };
  }

  async function local() {
    const res = await hostFetch(`${base()}/api/session`, { headers: { Connection: 'close' } });
    return caller(res.headers.getSetCookie().map((c) => c.split(';')[0]!));
  }

  /** A ticket exchanged through a proxy: loopback socket, forwarding headers, so a remote ('ticket') session. */
  async function remote() {
    const proxy = { 'X-Forwarded-For': '203.0.113.4', Host: 'buddi.tail1234.ts.net:9443' };
    const exchange = await hostFetch(`${base()}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { headers: { ...proxy, Connection: 'close' } });
    expect(exchange.status).toBe(302);
    const call = caller(exchange.headers.getSetCookie().map((c) => c.split(';')[0]!), proxy, 'https://buddi.tail1234.ts.net:9443');
    expect((await call('GET', '/api/session')).body).toMatchObject({ signedInThrough: 'ticket' });
    return call;
  }

  async function script() {
    const { token } = await createApiToken(pool, { name: 'cron', via: 'cli' });
    return async (method: string, route: string, body?: unknown) => {
      const res = await hostFetch(`${base()}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
    };
  }

  it('refuses a session signed in off this machine on every local-only route', async () => {
    const call = await remote();
    for (const [method, route, body] of LOCAL_ONLY) {
      expect((await call(method, route, body)).status, `${method} ${route}`).toBe(403);
    }
  });

  it('refuses an owner API token on every local-only route', async () => {
    const call = await script();
    for (const [method, route, body] of LOCAL_ONLY) {
      expect((await call(method, route, body)).status, `${method} ${route}`).toBe(403);
    }
  });

  it('answers them from this computer', async () => {
    const call = await local();
    expect((await call('GET', '/api/system/cli')).body).toMatchObject({ available: true });
    expect((await call('GET', '/api/system/uninstall')).body).toMatchObject({ available: true, token: expect.any(String) });
    expect((await call('GET', `/api/system/uninstall/jobs/${UNINSTALL_JOB}`)).body).toMatchObject({ report: { passphrase: PHRASE } });
    expect((await call('GET', '/api/backups/passphrase/notice')).body).toEqual({ show: true, passphrase: PHRASE });
  });

  it('holds the card\'s words behind the PIN when one is set; the card reveals them with it', async () => {
    const call = await local();
    expect((await call('PUT', '/api/lock/pin', { pin: '2468' })).status).toBe(200);
    const notice = await call('GET', '/api/backups/passphrase/notice');
    expect(notice.status).toBe(200);
    expect(notice.body).toEqual({ show: true, needsPin: true });
    expect(JSON.stringify(notice.body)).not.toContain('able');
    expect((await call('POST', '/api/backups/passphrase/reveal', {})).body).toMatchObject({ needsPin: true });
    expect((await call('POST', '/api/backups/passphrase/reveal', { pin: '2468' })).body).toEqual({ passphrase: PHRASE });
    // Acknowledged: the card is gone, PIN or not.
    await call('POST', '/api/backups/passphrase/notice', {});
    expect((await call('GET', '/api/backups/passphrase/notice')).body).toEqual({ show: false });
    // Through the route, so the lock service's cached state lets go of the PIN for the next test.
    expect((await call('POST', '/api/lock/pin/remove', { current: '2468' })).status).toBe(200);
  });

  it('never hands an uninstall\'s job, or a report\'s words, to the generic job routes', async () => {
    const callers = { local: await local(), remote: await remote(), token: await script() };
    for (const [who, call] of Object.entries(callers)) {
      for (const route of [`/api/backups/jobs/${UNINSTALL_JOB}`, `/api/upgrade/jobs/${UNINSTALL_JOB}`]) {
        const res = await call('GET', route);
        expect(res.status, `${who} ${route}`).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('able');
      }
      for (const route of [`/api/backups/jobs/${UPGRADE_JOB}`, `/api/upgrade/jobs/${UPGRADE_JOB}`]) {
        const res = await call('GET', route);
        expect(res.status, `${who} ${route}`).toBe(200);
        expect(res.body).toMatchObject({ report: { archive: '/pre.age' } });
        expect(JSON.stringify(res.body)).not.toContain('able');
      }
    }
  });
});
