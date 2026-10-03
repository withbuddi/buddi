/**
 * "Set it up for me" through the server: the routes, the background run the
 * panel polls, the setting it fills in (and the ingress listener that binds),
 * and Remove — against the fake Cloudflare API, with the token in memory.
 */
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from '../server.js';
import { csrfCookieName } from '../http.js';
import { mintTicket } from '../token.js';
import { hostFetch } from '../../__fixtures__/host-fetch.js';
import { TEAM, fakeTeam } from '../../__fixtures__/access-jwt.js';
import { FAKE_TOKEN, fakeCloudflare, type FakeCloudflare } from '../../__fixtures__/fake-cloudflare.js';
import { createJwks } from './cloudflare.js';
import { memoryTokenStore } from './cloudflare-token.js';
import { claimSetupOperation } from './cloudflare-setup.js';

const fetch = hostFetch;
const servers: WebServer[] = [];
const fakes: FakeCloudflare[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

function pool() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('from core.web_settings')) {
        const value = rows.get(String(params?.[0]));
        return { rows: value === undefined || value === null ? [] : [{ value }] };
      }
      if (sql.includes('into core.web_settings')) {
        rows.set(String(params?.[0]), JSON.parse(String(params?.[1])));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe('Set it up for me, through the server', () => {
  it('runs in the background, fills in the setting, binds the listener, and Remove undoes it', async () => {
    const cf = await fakeCloudflare({ team: TEAM });
    fakes.push(cf);
    const team = fakeTeam({ now: () => new Date() });
    const tokens = memoryTokenStore();
    const db = pool();
    const app = await startWebServer({
      pool: db as never,
      registry: new ToolRegistry(),
      catalog: {} as AgentCatalog,
      ctx: { ownerId: 'owner' } as CoreToolContext,
      timezone: 'UTC',
      now: () => new Date(),
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: 'fixture',
      env: {},
      openAccess: false,
      log: () => {},
      tailscale: { whois: async () => null, self: async () => ({ available: false, self: null }) },
      cloudflare: {
        jwks: createJwks({ transport: team.transport }),
        api: { baseUrl: cf.baseUrl },
        tokens,
        platform: 'linux',
        setup: { sleep: async () => {}, pollMs: 1 },
      },
    });
    servers.push(app);
    const main = `http://127.0.0.1:${app.port}`;
    const exchange = await fetch(`${main}/?t=${encodeURIComponent(mintTicket('fixture'))}`, { redirect: 'manual' });
    const cookies = exchange.headers.getSetCookie().map((c) => c.split(';')[0]!);
    const name = csrfCookieName(app.port);
    const csrf = cookies.find((c) => c.startsWith(`${name}=`))!.slice(name.length + 1);
    const headers = { Cookie: cookies.join('; '), Origin: main, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };

    // No token kept, none given.
    const none = await fetch(`${main}/api/access/cloudflare-access/setup`, { method: 'POST', headers, body: JSON.stringify({ host: 'buddi.example.com', email: 'sam@example.com' }) });
    expect(none.status).toBe(400);
    const badHost = await fetch(`${main}/api/access/cloudflare-access/setup`, { method: 'POST', headers, body: JSON.stringify({ token: FAKE_TOKEN, host: 'not a host', email: 'sam@example.com' }) });
    expect(badHost.status).toBe(400);

    const started = await fetch(`${main}/api/access/cloudflare-access/setup`, { method: 'POST', headers, body: JSON.stringify({ token: FAKE_TOKEN, host: 'buddi.example.com', email: 'sam@example.com' }) });
    expect(started.status).toBe(202);
    expect(tokens.value).toBe(FAKE_TOKEN);

    let view: { progress: { state: string; url: string | null; install: { command: string } | null }; tokenStored: boolean } | undefined;
    for (let i = 0; i < 100; i++) {
      view = await (await fetch(`${main}/api/access/cloudflare-access/setup`, { headers })).json() as typeof view;
      if (view!.progress.state === 'done' || view!.progress.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(view?.progress.state).toBe('done');
    expect(view?.progress.url).toBe('https://buddi.example.com');
    expect(view?.progress.install?.command).toMatch(/^sudo cloudflared service install eyJ-connector-token-for-/);
    expect(view?.tokenStored).toBe(true);
    expect(JSON.stringify(view)).not.toContain(FAKE_TOKEN);

    const setting = await (await fetch(`${main}/api/access/cloudflare-access`, { headers })).json() as { enabled: boolean; teamDomain: string; publicOrigin: string; listening: boolean };
    expect(setting).toMatchObject({ enabled: true, teamDomain: TEAM, publicOrigin: 'https://buddi.example.com', listening: true });
    expect(app.ingress.port()).toEqual(expect.any(Number));
    // The tunnel points at the listener that is actually bound.
    expect(cf.state.tunnels[0]?.config).toEqual({ ingress: [{ hostname: 'buddi.example.com', service: `http://127.0.0.1:${app.port + 2}` }, { service: 'http_status:404' }] });

    const removed = await fetch(`${main}/api/access/cloudflare-access/setup/remove`, { method: 'POST', headers, body: '{}' });
    const after = await removed.json() as { progress: { state: string; removed: string[]; error: string | null } };
    expect(after.progress).toMatchObject({ state: 'removed', error: null });
    expect(after.progress.removed).toHaveLength(4);
    expect(tokens.value).toBeNull();
    expect(cf.state.apps).toHaveLength(0);
    const offNow = await (await fetch(`${main}/api/access/cloudflare-access`, { headers })).json() as { enabled: boolean };
    expect(offNow.enabled).toBe(false);
    expect(app.ingress.port()).toBeNull();
  });

  it('stops waiting for the tunnel: the run says stopped, what it made stays, and the setting stays on', async () => {
    const t = await bench();
    t.cf.healthyAfter = 1_000_000;
    const started = await t.post('/setup', { token: FAKE_TOKEN, host: 'buddi.example.com', email: 'sam@example.com' });
    expect(started.status).toBe(202);
    await t.until((v) => v.progress.state === 'waiting');

    const stopped = await t.post('/setup/stop', {});
    expect(stopped.status).toBe(200);
    const view = await stopped.json() as View;
    expect(view.progress.state).toBe('stopped');
    expect(view.progress.error).toContain('Stopped waiting');
    expect(t.cf.state.tunnels.filter((x) => !x.deleted_at)).toHaveLength(1);
    expect(t.cf.state.apps).toHaveLength(1);
    const setting = await (await fetch(`${t.main}/api/access/cloudflare-access`, { headers: t.headers })).json() as { enabled: boolean };
    expect(setting.enabled).toBe(true);
    // Nothing is held after the stop: a new run may start.
    expect((await t.post('/setup', { host: 'buddi.example.com', email: 'sam@example.com' })).status).toBe(202);
    await t.post('/setup/stop', {});
  });

  it('runs one operation at a time: a second setup, a removal during a run, and Stop during a removal are 409s', async () => {
    const t = await bench();
    t.cf.healthyAfter = 1_000_000;
    const body = { token: FAKE_TOKEN, host: 'buddi.example.com', email: 'sam@example.com' };
    // Two at once: the lock is taken before either reads its body.
    const [a, b] = await Promise.all([t.post('/setup', body), t.post('/setup', body)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const refused = (a.status === 409 ? a : b);
    expect(((await refused.json()) as { error: string }).error).toBe('A Cloudflare setup is already running. Wait for it, or stop it, then try again.');
    await t.until((v) => v.progress.state === 'waiting');
    const removing = await t.post('/setup/remove', {});
    expect(removing.status).toBe(409);
    expect(t.cf.state.apps).toHaveLength(1);
    await t.post('/setup/stop', {});

    // A removal holding the lock (as the CLI's or the panel's would).
    const lease = claimSetupOperation('remove')!;
    try {
      const stop = await t.post('/setup/stop', {});
      expect(stop.status).toBe(409);
      expect(((await stop.json()) as { error: string }).error).toBe('buddi is removing what it made in Cloudflare. Wait for it to finish, then try again.');
      expect((await t.post('/setup', body)).status).toBe(409);
      expect((await t.post('/setup/remove', {})).status).toBe(409);
    } finally {
      lease.release();
    }
    const removed = await t.post('/setup/remove', {});
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as View).progress.state).toBe('removed');
  });

  it('stops at a tunnel buddi did not make, and takes it with adopt: true', async () => {
    const t = await bench();
    t.cf.state.tunnels.push({ id: 'their-tunnel', name: 'buddi-buddi.example.com', status: 'inactive', deleted_at: null });
    await t.post('/setup', { token: FAKE_TOKEN, host: 'buddi.example.com', email: 'sam@example.com' });
    const stopped = await t.until((v) => v.progress.state === 'failed');
    expect(stopped.progress.adoptable).toBe(true);
    expect(stopped.progress.error).toContain('Use it anyway');
    await t.post('/setup', { host: 'buddi.example.com', email: 'sam@example.com', adopt: true });
    const done = await t.until((v) => v.progress.state === 'done' || v.progress.state === 'failed');
    expect(done.progress.state).toBe('done');
    expect(t.cf.state.dns[0]?.content).toBe('their-tunnel.cfargotunnel.com');
  });
});

interface View { progress: { state: string; error: string | null; adoptable?: boolean; url: string | null; install: { command: string } | null }; tokenStored: boolean }

/** A server with the fake Cloudflare, a local browser session, and helpers. */
async function bench() {
  const cf = await fakeCloudflare({ team: TEAM });
  fakes.push(cf);
  const team = fakeTeam({ now: () => new Date() });
  const tokens = memoryTokenStore();
  const app = await startWebServer({
    pool: pool() as never,
    registry: new ToolRegistry(),
    catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC',
    now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    token: 'fixture',
    env: {},
    openAccess: false,
    log: () => {},
    tailscale: { whois: async () => null, self: async () => ({ available: false, self: null }) },
    cloudflare: {
      jwks: createJwks({ transport: team.transport }),
      api: { baseUrl: cf.baseUrl },
      tokens,
      platform: 'linux',
      setup: { sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }), pollMs: 1 },
    },
  });
  servers.push(app);
  const main = `http://127.0.0.1:${app.port}`;
  const exchange = await fetch(`${main}/?t=${encodeURIComponent(mintTicket('fixture'))}`, { redirect: 'manual' });
  const cookies = exchange.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const name = csrfCookieName(app.port);
  const csrf = cookies.find((c) => c.startsWith(`${name}=`))!.slice(name.length + 1);
  const headers = { Cookie: cookies.join('; '), Origin: main, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  const post = (tail: string, body: unknown) => fetch(`${main}/api/access/cloudflare-access${tail}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const until = async (done: (v: View) => boolean): Promise<View> => {
    let view: View | undefined;
    for (let i = 0; i < 200; i++) {
      view = await (await fetch(`${main}/api/access/cloudflare-access/setup`, { headers })).json() as View;
      if (done(view)) return view;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`the setup never got there: ${JSON.stringify(view?.progress)}`);
  };
  return { app, cf, tokens, main, headers, post, until };
}
