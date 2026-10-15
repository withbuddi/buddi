/**
 * A dashboard made without a data folder for Open in app watches nothing: no
 * test that leaves it out can read or rewrite `<repo>/data/open`. The routes
 * then say it is not available. Only serve (and a test that wants it, with a
 * temp folder) names the folder.
 */
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { afterEach, expect, it, vi } from 'vitest';
import { csrfCookieName } from './http.js';
import { startWebServer, type WebServer } from './server.js';

const made = vi.hoisted(() => [] as unknown[]);
vi.mock('./open-in-app.js', async (original) => {
  const real = await original<typeof import('./open-in-app.js')>();
  class Watched extends real.OpenInApp {
    constructor(opts: ConstructorParameters<typeof real.OpenInApp>[0]) {
      super(opts);
      made.push(opts.dataDir);
    }
  }
  return { ...real, OpenInApp: Watched };
});

const servers: WebServer[] = [];
afterEach(async () => {
  made.length = 0;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function dashboard(extra: { openInApp?: { dataDir: string } } = {}): Promise<WebServer> {
  const app = await startWebServer({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never, registry: new ToolRegistry(), catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as CoreToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture', ...extra,
  });
  servers.push(app);
  return app;
}

const FILE = 'f0000000-0000-4000-8000-000000000000';

it('starts no watcher without a data folder, and says Open in app is not available', async () => {
  const app = await dashboard();
  expect(made).toEqual([]);
  const origin = `http://127.0.0.1:${app.port}`;
  const cookies = (await fetch(`${origin}/api/session`)).headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith(`${csrfCookieName(app.port)}=`))!.slice(`${csrfCookieName(app.port)}=`.length);
  const headers = { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  const status = await fetch(`${origin}/api/files/${FILE}/open`, { headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ open: false });
  const open = await fetch(`${origin}/api/files/${FILE}/open`, { method: 'POST', headers, body: '{}' });
  expect(open.status).toBe(503);
});

it('watches the folder it is given', async () => {
  await dashboard({ openInApp: { dataDir: '/nonexistent/buddi-guard' } });
  expect(made).toEqual(['/nonexistent/buddi-guard']);
});
