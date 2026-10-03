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
});
