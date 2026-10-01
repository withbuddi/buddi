/**
 * Owner API tokens over the wire (docs/api.md, "Authentication"): made from
 * the dashboard, kept hashed, accepted as `Authorization: Bearer`, refused on
 * the routes a token may not call, ended by revoking, and counted as a failed
 * sign-in when wrong. Against a throwaway database; skipped unless
 * DATABASE_URL is set.
 */
import { createHash } from 'node:crypto';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  migrate,
  ToolRegistry,
  type AgentCatalog,
  type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_TOKEN_PATTERN, bearerOf, createApiToken, hashApiToken, listApiTokens, MAX_API_TOKENS, newApiToken, revokeApiToken, verifyApiToken } from './api-tokens.js';
import { csrfCookieName, portOf } from './http.js';
import { startWebServer, type WebServer } from './server.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_api_tokens_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const now = (): Date => new Date();

const catalog = {
  get: () => undefined,
  byHandle: () => undefined,
  list: () => [],
  agentsWithRole: () => [],
  defaultAgent: () => { throw new Error('no agents'); },
  resolve: () => undefined,
} as unknown as AgentCatalog;

/** A browser: the cookies it was given, and the CSRF pair on every write. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const write: Record<string, string> = init.method && init.method !== 'GET'
      ? { 'x-buddi-csrf': this.cookies.get(csrfCookieName(portOf(new URL(this.base)))) ?? '', origin: this.base, 'content-type': 'application/json' }
      : {};
    const res = await fetch(`${this.base}${path}`, { redirect: 'manual', ...init, headers: { ...(jar ? { cookie: jar } : {}) as Record<string, string>, ...write, ...((init.headers ?? {}) as Record<string, string>) } });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) this.cookies.set((pair as string).slice(0, eq), (pair as string).slice(eq + 1));
    }
    return res;
  }
  async signIn(): Promise<void> {
    await this.fetch('/api/session');
  }
}

/** A script: the token, and nothing else — no cookie, no CSRF, no Origin. */
function script(base: string, token: string) {
  return (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
}

describe('API token shape', () => {
  it('is buddi_ and 32 random bytes, and its digest is SHA-256 hex', () => {
    const a = newApiToken();
    const b = newApiToken();
    expect(a).toMatch(API_TOKEN_PATTERN);
    expect(a).not.toBe(b);
    expect(hashApiToken(a)).toBe(createHash('sha256').update(a).digest('hex'));
    expect(hashApiToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is read from a Bearer header only', () => {
    expect(bearerOf('Bearer buddi_x')).toBe('buddi_x');
    expect(bearerOf('bearer   buddi_x ')).toBe('buddi_x');
    expect(bearerOf('Basic abc')).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
  });
});

suite('owner API tokens', () => {
  let admin: Pool;
  let pool: Pool;
  let open: WebServer;
  let closed: WebServer;
  let openBase: string;
  let base: string;
  let common: Parameters<typeof startWebServer>[0];

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now, timezone: 'UTC' };
    common = { pool, registry: new ToolRegistry(), catalog, ctx, timezone: 'UTC', now, token: TOKEN, log: () => {}, config: { enabled: true, host: '127.0.0.1', port: 0 } };
    // The open loopback binding, where the dashboard mints a session; and one that asks for sign-in, as an install does.
    open = await startWebServer(common);
    openBase = `http://127.0.0.1:${open.port}`;
    closed = await startWebServer({ ...common, openAccess: false });
    base = `http://127.0.0.1:${closed.port}`;
  }, 60_000);

  afterAll(async () => {
    await open?.close();
    await closed?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('delete from core.api_tokens');
  });

  it('is made from the dashboard, shown once, and kept only as its digest', async () => {
    const browser = new Browser(openBase);
    await browser.signIn();
    const res = await browser.fetch('/api/api-tokens', { method: 'POST', body: JSON.stringify({ name: '  home   automation ' }) });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { token: string; apiToken: { id: string; name: string; hint: string; createdVia: string } };
    expect(made.token).toMatch(API_TOKEN_PATTERN);
    expect(made.apiToken).toMatchObject({ name: 'home automation', hint: made.token.slice(-4), createdVia: 'dashboard' });

    const { rows } = await pool.query('select * from core.api_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashApiToken(made.token));
    // Nowhere in the row is the token itself.
    expect(JSON.stringify(rows[0])).not.toContain(made.token.slice(6, 30));

    const list = (await (await browser.fetch('/api/api-tokens')).json()) as { tokens: Array<Record<string, unknown>> };
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(made.token);
    expect(list.tokens[0]).toMatchObject({ id: made.apiToken.id, hint: made.token.slice(-4), lastUsedAt: null });
  });

  it('refuses a token with no name or one too long, and a twenty-first', async () => {
    const browser = new Browser(openBase);
    await browser.signIn();
    expect((await browser.fetch('/api/api-tokens', { method: 'POST', body: JSON.stringify({ name: ' ' }) })).status).toBe(400);
    expect((await browser.fetch('/api/api-tokens', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(61) }) })).status).toBe(400);
    for (let i = 0; i < MAX_API_TOKENS; i += 1) await createApiToken(pool, { name: `t${i}`, via: 'cli' });
    const over = await browser.fetch('/api/api-tokens', { method: 'POST', body: JSON.stringify({ name: 'one more' }) });
    expect(over.status).toBe(409);
  });

  it('lets a script in where a cookie-less request is signed out, as the owner, with no CSRF or Origin', async () => {
    const { token } = await createApiToken(pool, { name: 'cron', via: 'cli' });
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    const call = script(base, token);
    const overview = await call('/api/overview');
    expect(overview.status).toBe(200);
    const session = (await (await call('/api/session')).json()) as { signedInThrough: string };
    expect(session.signedInThrough).toBe('token');
    // A write, without the CSRF pair a browser needs.
    const paused = await call('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    expect(paused.status).toBe(200);
    expect((await call('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) })).status).toBe(200);
    // Used: the list says when.
    expect((await listApiTokens(pool))[0]?.lastUsedAt).not.toBeNull();
    // Not a route: the same 404 a session gets.
    expect((await call('/api/nothing-here')).status).toBe(404);
  });

  it('never decides an approval, grants, installs, opens access or reads a secret — and may say no', async () => {
    const { token } = await createApiToken(pool, { name: 'cron', via: 'cli' });
    const call = script(base, token);
    const refused: Array<[string, string, unknown?]> = [
      ['POST', '/api/approvals/00000000-0000-4000-8000-000000000000/approve', { permissionScope: 'always' }],
      ['POST', '/api/proposals/p1/keep', {}],
      ['POST', '/api/plugins/web/agents/scout/accept', {}],
      ['POST', '/api/agents/scout/file', { tools: ['*'] }],
      ['POST', '/api/connections/remembered', { agent: 'scout', tool: 'x', remember: true }],
      ['POST', '/api/plugins/stage', { spec: 'evil' }],
      // First run's take-on installs plugins with the owner's approval recorded for them.
      ['POST', '/api/onboarding/take-on', { tiles: ['days'] }],
      ['PUT', '/api/lock/pin', { pin: '1234' }],
      ['POST', '/api/api-tokens', { name: 'another' }],
      ['GET', '/api/api-tokens'],
      ['POST', '/api/secrets/act', { tool: 'secrets.set', args: {} }],
      ['GET', '/api/backups/passphrase'],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/^An API token cannot call /);
    }
    expect((await pool.query('select count(*)::int as n from core.api_tokens')).rows[0].n).toBe(1);
    // Rejecting reaches the route (no such action here), as does a write through buddi mcp, which only ever asks.
    expect((await call('/api/approvals/00000000-0000-4000-8000-000000000000/reject', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('is refused from the next request on once revoked, from Settings or the terminal', async () => {
    const one = await createApiToken(pool, { name: 'one', via: 'dashboard' });
    const two = await createApiToken(pool, { name: 'two', via: 'cli' });
    expect((await script(base, one.token)('/api/overview')).status).toBe(200);

    const browser = new Browser(openBase);
    await browser.signIn();
    expect((await browser.fetch(`/api/api-tokens/${one.apiToken.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await browser.fetch(`/api/api-tokens/${one.apiToken.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await script(base, one.token)('/api/overview')).status).toBe(401);

    // `buddi api-token revoke` takes the first characters of an id.
    expect(await revokeApiToken(pool, two.apiToken.id.slice(0, 8))).toMatchObject({ name: 'two' });
    expect(await verifyApiToken(pool, two.token)).toBeNull();
    expect((await script(base, two.token)('/api/overview')).status).toBe(401);
  });

  it('counts a wrong token as a failed sign-in: ten distinct ones and the address waits, the right token included', async () => {
    const fresh = await startWebServer({ ...common, openAccess: false });
    try {
      const at = `http://127.0.0.1:${fresh.port}`;
      const { token } = await createApiToken(pool, { name: 'good', via: 'cli' });
      // The same stale token sent again and again counts once.
      const stale = newApiToken();
      for (let i = 0; i < 15; i += 1) expect((await script(at, stale)('/api/overview')).status).toBe(401);
      expect((await script(at, token)('/api/overview')).status).toBe(200);
      for (let i = 0; i < 9; i += 1) expect((await script(at, newApiToken())('/api/overview')).status).toBe(401);
      const blocked = await script(at, newApiToken())('/api/overview');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await script(at, token)('/api/overview')).status).toBe(429);
      // A garbled one counts too, though it never reaches the database.
      expect((await script(at, 'not-a-token')('/api/overview')).status).toBe(429);
    } finally {
      await fresh.close();
    }
  });

  it('is not covered by the lock screen', async () => {
    const browser = new Browser(openBase);
    await browser.signIn();
    expect((await browser.fetch('/api/lock/pin', { method: 'PUT', body: JSON.stringify({ pin: '2468' }) })).status).toBe(200);
    try {
      expect((await browser.fetch('/api/lock', { method: 'POST', body: '{}' })).status).toBe(200);
      expect((await browser.fetch('/api/overview')).status).toBe(423);
      const { token } = await createApiToken(pool, { name: 'cron', via: 'cli' });
      expect((await script(openBase, token)('/api/overview')).status).toBe(200);
    } finally {
      await browser.fetch('/api/lock/unlock', { method: 'POST', body: JSON.stringify({ pin: '2468' }) });
      await browser.fetch('/api/lock/pin/remove', { method: 'POST', body: JSON.stringify({ current: '2468' }) });
    }
  });
});
