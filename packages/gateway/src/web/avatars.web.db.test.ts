/**
 * Agent pictures over the wire: upload, re-encode, serve, remove — and the
 * bot's profile photo following the default agent's. Against a throwaway
 * database; skipped unless DATABASE_URL is set.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  migrate,
  readWebSetting,
  ToolRegistry,
  type AgentCatalog,
  type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import pngjs from 'pngjs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { PROFILE_PHOTO_SETTING, syncProfilePhoto } from '../telegram/profile-photo.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_avatars_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const now = (): Date => new Date();

const scout = {
  id: 'scout',
  handle: 'scout',
  name: 'Scout',
  description: 'Looks around.',
  available: true,
  roles: [],
  providerKind: 'fake',
  avatar: '🦊',
};
const catalog = {
  get: (id: string) =>
    id === 'scout'
      ? { ...scout, file: '/nonexistent/scout/agent.md', provider: { kind: 'fake', model: 'm', credential: {} }, model: 'm', thinking: null, tools: [], skills: [], isDefault: true, maxTurns: 5, language: 'en', source: 'owner' }
      : undefined,
  byHandle: () => undefined,
  list: () => [scout],
  agentsWithRole: () => [],
  defaultAgent: () => ({ id: 'scout' }),
  resolve: () => undefined,
} as unknown as AgentCatalog;

function png(width: number, height: number): Buffer {
  const image = new pngjs.PNG({ width, height });
  image.data.fill(200);
  return pngjs.PNG.sync.write(image);
}

class Client {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) this.cookies.set((pair as string).slice(0, eq), (pair as string).slice(eq + 1));
    }
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${this.base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { ...(jar ? { cookie: jar } : {}), ...(init.headers ?? {}) },
    });
    this.absorb(res);
    return res;
  }
  private write(): Record<string, string> {
    return { 'x-buddi-csrf': this.cookies.get('buddi_csrf') ?? '', origin: this.base };
  }
  async upload(path: string, file: { name: string; type: string; bytes: Buffer }): Promise<Response> {
    await this.fetch('/api/session');
    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
    return this.fetch(path, { method: 'POST', body: form, headers: this.write() });
  }
  async delete(path: string): Promise<Response> {
    await this.fetch('/api/session');
    return this.fetch(path, { method: 'DELETE', headers: this.write() });
  }
}

suite('agent pictures', () => {
  let admin: Pool;
  let pool: Pool;
  let web: WebServer;
  let closed: WebServer;
  let base: string;
  const changed: string[] = [];

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
    const common = { pool, registry: new ToolRegistry(), catalog, ctx, timezone: 'UTC', now, token: TOKEN, log: () => {} };
    web = await startWebServer({
      ...common,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      telegram: { running: () => true, pictureChanged: (id) => changed.push(id) },
    });
    base = `http://127.0.0.1:${web.port}`;
    closed = await startWebServer({ ...common, config: { enabled: true, host: '127.0.0.1', port: 0 }, openAccess: false });
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
    changed.length = 0;
    await pool.query('delete from core.agent_avatars');
    await pool.query('delete from core.web_settings where key = $1', [PROFILE_PHOTO_SETTING]);
  });

  it('takes a PNG, keeps a square 512 PNG, and puts a versioned URL on the roster', async () => {
    const client = new Client(base);
    const res = await client.upload('/api/agents/scout/avatar', { name: 'me.png', type: 'image/png', bytes: png(900, 700) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { picture: string; side: number };
    expect(body.side).toBe(512);
    expect(body.picture).toMatch(/^\/api\/agents\/scout\/avatar\?v=[0-9a-f]{16}$/);
    expect(changed).toEqual(['scout']);

    const roster = (await (await client.fetch('/api/chat/agents')).json()) as { agents: Array<{ id: string; picture?: string; avatar?: unknown }> };
    expect(roster.agents[0]?.picture).toBe(body.picture);
    // The icon stays on the roster: it is the fallback.
    expect(roster.agents[0]?.avatar).toEqual({ kind: 'emoji', value: '🦊' });
    const agents = (await (await client.fetch('/api/agents')).json()) as { agents: Array<{ picture?: string }> };
    expect(agents.agents[0]?.picture).toBe(body.picture);

    const { rows } = await pool.query('select side, source, length(png) as n from core.agent_avatars');
    expect(rows[0]).toMatchObject({ side: 512, source: 'png' });
  });

  it('serves it as image/png with nosniff and a strong ETag, and answers 304 to it', async () => {
    const client = new Client(base);
    await client.upload('/api/agents/scout/avatar', { name: 'me.png', type: 'image/png', bytes: png(40, 40) });
    const res = await client.fetch('/api/agents/scout/avatar');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(pngjs.PNG.sync.read(bytes).width).toBe(40);
    const again = await client.fetch('/api/agents/scout/avatar', { headers: { 'if-none-match': etag! } });
    expect(again.status).toBe(304);
  });

  it('asks for the same session as every other route', async () => {
    const outsider = new Client(`http://127.0.0.1:${closed.port}`);
    expect((await outsider.fetch('/api/agents/scout/avatar')).status).toBe(401);
    const form = new FormData();
    form.append('file', new Blob([png(4, 4)], { type: 'image/png' }), 'x.png');
    expect((await outsider.fetch('/api/agents/scout/avatar', { method: 'POST', body: form })).status).toBe(401);
  });

  it('refuses a write without the CSRF header', async () => {
    const client = new Client(base);
    await client.fetch('/api/session');
    const form = new FormData();
    form.append('file', new Blob([png(4, 4)], { type: 'image/png' }), 'x.png');
    const res = await client.fetch('/api/agents/scout/avatar', { method: 'POST', body: form, headers: { origin: base } });
    expect(res.status).toBe(403);
  });

  it('rasterises an SVG and never serves SVG', async () => {
    const client = new Client(base);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10" fill="red"/></svg>');
    const res = await client.upload('/api/agents/scout/avatar', { name: 'me.svg', type: 'image/svg+xml', bytes: svg });
    expect(res.status).toBe(200);
    const served = await client.fetch('/api/agents/scout/avatar');
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).toString('latin1')).not.toContain('script');
  });

  it('refuses over 1 MB, and what is not a picture, keeping nothing', async () => {
    const client = new Client(base);
    const big = await client.upload('/api/agents/scout/avatar', { name: 'big.png', type: 'image/png', bytes: Buffer.concat([png(4, 4), Buffer.alloc(1024 * 1024)]) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/1 MB/);
    const html = await client.upload('/api/agents/scout/avatar', { name: 'x.png', type: 'image/png', bytes: Buffer.from('<html></html>') });
    expect(html.status).toBe(415);
    expect((await pool.query('select 1 from core.agent_avatars')).rows).toHaveLength(0);
    expect(changed).toEqual([]);
  });

  it('refuses an agent that does not exist', async () => {
    const client = new Client(base);
    const res = await client.upload('/api/agents/nobody/avatar', { name: 'me.png', type: 'image/png', bytes: png(4, 4) });
    expect(res.status).toBe(404);
  });

  it('removes it, and the icon is what is left', async () => {
    const client = new Client(base);
    await client.upload('/api/agents/scout/avatar', { name: 'me.png', type: 'image/png', bytes: png(4, 4) });
    expect((await client.delete('/api/agents/scout/avatar')).status).toBe(204);
    expect(changed).toEqual(['scout', 'scout']);
    const roster = (await (await client.fetch('/api/chat/agents')).json()) as { agents: Array<{ picture?: string }> };
    expect(roster.agents[0]?.picture).toBeUndefined();
    // No picture, and the icon is an emoji rather than a file: nothing to serve.
    expect((await client.fetch('/api/agents/scout/avatar')).status).toBe(404);
  });

  it('sets the bot photo to the default agent\'s picture once, and takes down only its own', async () => {
    const calls: string[] = [];
    const api = {
      setMyProfilePhoto: async (jpeg: Buffer) => {
        expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        calls.push('set');
      },
      removeMyProfilePhoto: async () => {
        calls.push('remove');
      },
    };
    const deps = { api, pool, catalog };
    // Nothing uploaded, nothing ever pushed: a BotFather photo is left alone.
    expect(await syncProfilePhoto(deps)).toBe('unchanged');
    await new Client(base).upload('/api/agents/scout/avatar', { name: 'me.png', type: 'image/png', bytes: png(8, 8) });
    expect(await syncProfilePhoto(deps)).toBe('set');
    expect(await syncProfilePhoto(deps)).toBe('unchanged');
    await pool.query('delete from core.agent_avatars');
    expect(await syncProfilePhoto(deps)).toBe('removed');
    expect(await syncProfilePhoto(deps)).toBe('unchanged');
    expect(calls).toEqual(['set', 'remove']);
    expect(await readWebSetting(pool, PROFILE_PHOTO_SETTING)).toEqual({ sha256: null });
  });
});
