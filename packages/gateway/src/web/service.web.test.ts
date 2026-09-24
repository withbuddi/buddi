/**
 * The service routes, against a supervisor that is only a socket in a
 * temporary directory. Nothing here starts a real supervisor, and nothing here
 * touches the owner's installation.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { afterEach, expect, it, vi } from 'vitest';
import { startWebServer, type WebServer } from './server.js';

const servers: WebServer[] = [];
const fakes: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(fakes.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const STATUS = { phase: 'ready', supervisorPid: 11, installRoot: '/install', nodePath: '/node', database: 'running', databasePid: 22, gateway: 'running', gatewayPid: 33 };

/** A supervisor, as far as these routes can tell: four routes on a socket. */
async function fakeSupervisor(): Promise<{ socket: string; seen: string[] }> {
  const seen: string[] = [];
  const socket = path.join(await mkdtemp(path.join(tmpdir(), 'buddi-service-')), 'supervisor.sock');
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const ok = (req.method === 'GET' && req.url === '/status') || (req.method === 'POST' && ['/start', '/stop', '/restart'].includes(req.url ?? ''));
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? STATUS : { error: 'no such endpoint' }));
  });
  fakes.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); });
  return { socket, seen };
}

async function dashboard(env: NodeJS.ProcessEnv): Promise<WebServer> {
  const app = await startWebServer({
    pool: {} as never, registry: new ToolRegistry(), catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture', env,
  });
  servers.push(app);
  return app;
}

it('reports the supervisor and proxies its actions behind the session and CSRF gate', async () => {
  const { socket, seen } = await fakeSupervisor();
  const app = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket });
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf };

  const view = await fetch(`${origin}/api/service`, { headers });
  expect(view.status).toBe(200);
  expect(await view.json()).toEqual({ supervised: true, status: STATUS });

  // The gate is the dashboard's own: no session, no CSRF, no foreign origin.
  expect((await fetch(`${origin}/api/service`, { headers: { 'X-Forwarded-For': '100.64.0.2' } })).status).toBe(401);
  for (const changed of [{ ...headers, 'X-Buddi-CSRF': '' }, { ...headers, Origin: 'https://untrusted.example' }]) {
    expect((await fetch(`${origin}/api/service/restart`, { method: 'POST', headers: changed })).status).toBe(403);
  }
  expect(seen).toEqual(['GET /status']);

  // `start` is answered with what the supervisor reports, because this gateway
  // survives it.
  const started = await fetch(`${origin}/api/service/start`, { method: 'POST', headers });
  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({ supervised: true, status: STATUS });

  // `stop` and `restart` kill the process that would compose the reply, so the
  // reply goes first and the supervisor is called once it is on the wire.
  for (const action of ['stop', 'restart'] as const) {
    const accepted = await fetch(`${origin}/api/service/${action}`, { method: 'POST', headers });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ supervised: true, pending: action });
    await vi.waitFor(() => expect(seen).toContain(`POST /${action}`));
  }
  expect(seen).toEqual(['GET /status', 'POST /start', 'POST /stop', 'POST /restart']);
});

it('has nothing to control without a supervisor, and says so rather than guessing', async () => {
  const app = await dashboard({});
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf };
  expect(await (await fetch(`${origin}/api/service`, { headers })).json()).toEqual({ supervised: false });
  expect((await fetch(`${origin}/api/service/restart`, { method: 'POST', headers })).status).toBe(404);
});

it('answers 503 when the socket is named but nothing is listening', async () => {
  const app = await dashboard({ BUDDI_SUPERVISOR_SOCKET: path.join(await mkdtemp(path.join(tmpdir(), 'buddi-service-')), 'absent.sock') });
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  expect((await fetch(`${origin}/api/service`, { headers: { Cookie: cookies.join('; ') } })).status).toBe(503);
});

it('reports a launchd job as supervised, with nothing to control from here', async () => {
  // What launchd hands the job `buddi service` installs: its label, no socket.
  const app = await dashboard({ XPC_SERVICE_NAME: 'com.buddi.serve' });
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf };
  expect(await (await fetch(`${origin}/api/service`, { headers })).json()).toEqual({ supervised: true, supervisor: 'launchd', label: 'com.buddi.serve' });
  expect((await fetch(`${origin}/api/service/restart`, { method: 'POST', headers })).status).toBe(404);
  // Another launchd job (a terminal opened from one, say) is not this service.
  const other = await dashboard({ XPC_SERVICE_NAME: 'application.com.apple.Terminal.123' });
  const o2 = `http://127.0.0.1:${other.port}`;
  const s2 = await fetch(`${o2}/api/session`);
  const c2 = s2.headers.getSetCookie().map((c) => c.split(';')[0]!);
  expect(await (await fetch(`${o2}/api/service`, { headers: { Cookie: c2.join('; '), Origin: o2 } })).json()).toEqual({ supervised: false });
});
