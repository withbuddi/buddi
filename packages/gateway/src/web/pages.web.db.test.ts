/**
 * The plugin page routes, over the wire, against a throwaway database.
 *
 * The suite registers the synthetic `demo` plugin — the one that uses every
 * component once — and asserts the properties the spec argues for rather than
 * the shape of the JSON:
 *
 *   - the descriptors are served, and they say which plugin they came from;
 *   - a query's parameters are checked by the *query's own* schema;
 *   - a query cannot write: the pool it is handed refuses the statement;
 *   - a write goes through the registry as the owner — an `auto` tool answers
 *     with its result, a `gated` one with an approval id and a real action row;
 *   - a page may name only its own plugin's tools, and a write is CSRF-checked
 *     like every other write.
 *
 * Skipped unless DATABASE_URL is set.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  migrate,
  ToolRegistry,
  type AgentCatalog,
  type PluginManifest,
  type ToolContext,
} from '@buddi/core';
import { DEMO_DATA, demoPagesManifest, demoWrites } from '@buddi/core/testing/pages';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_pages_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const now = (): Date => new Date();

/** A second plugin, so "only this plugin's tools" has something to refuse. */
const otherManifest: PluginManifest = {
  name: 'other',
  version: '1.0.0',
  schema: 'other',
  migrationsDir: '',
  tools: [
    {
      name: 'other.write',
      description: 'Write something else.',
      tier: 'auto',
      input: z.object({}).strict(),
      async execute() {
        return { wrote: true };
      },
    },
  ],
};

/** The smallest catalog the server will take. No page route reads it. */
const emptyCatalog = (): AgentCatalog =>
  ({
    get: () => undefined,
    byHandle: () => undefined,
    list: () => [],
    agentsWithRole: () => [],
    agentForRole: () => ({ ok: false, problem: { code: 'no-agent-for-role', role: '', message: 'none' } }),
    defaultAgent: () => undefined,
    resolve: () => undefined,
  }) as unknown as AgentCatalog;

class Client {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  get csrf(): string {
    return this.cookies.get('buddi_csrf') ?? '';
  }
  private header(): Record<string, string> {
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return jar === '' ? {} : { cookie: jar };
  }
  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) this.cookies.set((pair as string).slice(0, eq), (pair as string).slice(eq + 1));
    }
  }
  async get(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { ...this.header(), ...(init.headers ?? {}) },
    });
    this.absorb(res);
    return res;
  }
  async json<T>(path: string, expected = 200): Promise<T> {
    const res = await this.get(path);
    expect(res.status).toBe(expected);
    return (await res.json()) as T;
  }
  async post(path: string, body: unknown, opts: { csrf?: string | null; origin?: string | null } = {}): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (csrf !== null) headers['x-buddi-csrf'] = csrf;
    const origin = opts.origin === undefined ? this.base : opts.origin;
    if (origin !== null) headers.origin = origin;
    return this.get(path, { method: 'POST', body: JSON.stringify(body), headers });
  }
}

suite('the plugin page routes', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let closed: WebServer;
  let base: string;
  let closedBase: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');

    const registry = new ToolRegistry();
    registry.register(demoPagesManifest);
    registry.register(otherManifest);
    const ctx: ToolContext = { db: pool, ownerId: 'owner', now, timezone: 'UTC' };

    web = await startWebServer({
      pool,
      registry,
      catalog: emptyCatalog(),
      ctx,
      timezone: 'UTC',
      now,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      log: () => {},
    });
    base = `http://127.0.0.1:${web.port}`;
    closed = await startWebServer({
      pool,
      registry,
      catalog: emptyCatalog(),
      ctx,
      timezone: 'UTC',
      now,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: TOKEN,
      openAccess: false,
      log: () => {},
    });
    closedBase = `http://127.0.0.1:${closed.port}`;
  }, 60_000);

  afterAll(async () => {
    await web?.close();
    await closed?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    demoWrites.length = 0;
    await pool.query('truncate core.effect_attempts, core.approvals, core.actions cascade');
  });

  /* ---------------- the descriptors ---------------- */

  it('serves every descriptor, each naming the plugin it came from', async () => {
    const client = new Client(base);
    const body = await client.json<{ pages: Array<{ plugin: string; id: string; place: string; icon?: string }> }>(
      '/api/pages',
    );
    expect(body.pages.map((p) => `${p.plugin}/${p.id}`)).toEqual(['demo/board', 'demo/settings']);
    expect(body.pages[0]?.place).toBe('rail');
    expect(body.pages[0]?.icon).toBe('chart');
    // Data, all the way down: a query's function and schema never leave.
    expect(JSON.stringify(body.pages)).not.toContain('produce');
  });

  it('is session-gated like every other read', async () => {
    const res = await new Client(closedBase).get('/api/pages');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  /* ---------------- the queries ---------------- */

  it('answers a query, and validates its parameters with the query\'s own schema', async () => {
    const client = new Client(base);
    const all = await client.json<{ data: { items: unknown[] } }>('/api/pages/demo/items');
    expect(all.data.items).toHaveLength(2);

    const filtered = await client.json<{ data: { items: Array<{ id: string }> } }>('/api/pages/demo/items?state=done');
    expect(filtered.data.items.map((i) => i.id)).toEqual(['a2']);

    const one = await client.json<{ data: { id: string } }>('/api/pages/demo/item?id=a1');
    expect(one.data.id).toBe(DEMO_DATA.item.id);
  });

  it('refuses a missing parameter in the plugin\'s own words', async () => {
    const res = await new Client(base).get('/api/pages/demo/item');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/id/);
  });

  it('refuses a parameter the query never declared', async () => {
    const res = await new Client(base).get('/api/pages/demo/item?id=a1&sneaky=1');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/sneaky/);
  });

  it('is 404 for a query nobody contributes', async () => {
    const res = await new Client(base).get('/api/pages/demo/nope');
    expect(res.status).toBe(404);
  });

  it('hands a query a pool that answers', async () => {
    const body = await new Client(base).json<{ data: { n: number } }>('/api/pages/demo/probe');
    expect(body.data.n).toBe(1);
  });

  it('refuses a query that tries to write, and writes nothing', async () => {
    const res = await new Client(base).get('/api/pages/demo/naughty');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/is not a read/);
    const flag = await pool.query<{ value: unknown }>(`select value from core.system_flags where key = 'paused'`);
    expect(flag.rows[0]?.value).toBe(false);
  });

  /* ---------------- the writes ---------------- */

  it('runs an auto tool as the owner and answers with its result', async () => {
    const client = new Client(base);
    await client.get('/api/session');
    const res = await client.post('/api/pages/demo/act', { tool: 'demo.keep', args: { id: 'a1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { kept: 'a1' } });
    expect(demoWrites).toEqual([{ tool: 'demo.keep', args: { id: 'a1' } }]);
  });

  it('runs an ownerOnly tool, which no model is ever shown', async () => {
    const client = new Client(base);
    await client.get('/api/session');
    const res = await client.post('/api/pages/demo/act', {
      tool: 'demo.add_account',
      args: { address: 'owner@example.com', password: 'hunter2' },
    });
    expect(res.status).toBe(200);
    expect(demoWrites).toEqual([{ tool: 'demo.add_account', args: { address: 'owner@example.com' } }]);
  });

  it('answers a gated tool with an approval id, and records the action', async () => {
    const client = new Client(base);
    await client.get('/api/session');
    const res = await client.post('/api/pages/demo/act', { tool: 'demo.send', args: { id: 'd1' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvalId: string; preview: string };
    expect(body.preview).toBe('Send draft d1');
    const action = await pool.query<{ tool: string; agent_id: string }>(
      'select tool, agent_id from core.actions where id = $1',
      [body.approvalId],
    );
    expect(action.rows[0]).toEqual({ tool: 'demo.send', agent_id: 'owner' });
    // Nothing ran: a gated tool waits for the owner's decision, from here too.
    expect(demoWrites).toEqual([]);
  });

  it('refuses arguments the tool\'s schema refuses', async () => {
    const client = new Client(base);
    await client.get('/api/session');
    const res = await client.post('/api/pages/demo/act', { tool: 'demo.keep', args: { id: 7 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/id/);
  });

  it('will not name another plugin\'s tool, or a core one', async () => {
    const client = new Client(base);
    await client.get('/api/session');
    for (const tool of ['other.write', 'platform.create_agent', 'demo.nothing']) {
      const res = await client.post('/api/pages/demo/act', { tool, args: {} });
      expect(res.status).toBe(404);
    }
    expect(demoWrites).toEqual([]);
  });

  it('is CSRF- and Origin-checked like every other write', async () => {
    const client = new Client(base);
    await client.get('/api/session');
    expect((await client.post('/api/pages/demo/act', { tool: 'demo.keep', args: { id: 'a1' } }, { csrf: null })).status).toBe(403);
    expect(
      (await client.post('/api/pages/demo/act', { tool: 'demo.keep', args: { id: 'a1' } }, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    expect(demoWrites).toEqual([]);
  });
});
