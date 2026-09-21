/**
 * The version and upgrade routes, against a supervisor that is only a socket
 * in a temporary directory. Nothing here installs anything, reaches a registry
 * or touches the owner's installation.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { afterEach, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';

const servers: WebServer[] = [];
const fakes: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(fakes.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const VERSION = {
  current: '0.1.0',
  latest: '0.1.1',
  checkedAt: '2026-01-02T03:04:05.000Z',
  checkEnabled: true,
  updateAvailable: true,
  history: [{ from: '0.0.9', to: '0.1.0', startedAt: '2025-12-01T00:00:00.000Z', outcome: 'done', backup: 'buddi-backup-20251201-000000.tar.gz' }],
};

const JOB = { id: '11111111-2222-4333-8444-555555555555', phase: 'backup', phases: ['backup'], startedAt: '2026-01-02T03:04:06.000Z' };

/** A supervisor, as far as these routes can tell: four routes on a socket. */
async function fakeSupervisor(): Promise<{ socket: string; seen: string[]; bodies: string[] }> {
  const seen: string[] = [];
  const bodies: string[] = [];
  const socket = path.join(await mkdtemp(path.join(tmpdir(), 'buddi-version-')), 'supervisor.sock');
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { text += chunk; });
    req.on('end', () => {
      if (text !== '') bodies.push(text);
      const route = req.url ?? '';
      if (req.method === 'POST' && route === '/upgrade') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ job: JOB }));
      }
      // The supervisor keeps one job route for backups and upgrades alike.
      if (req.method === 'GET' && route.startsWith('/jobs/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...JOB, phase: 'installing' }));
      }
      const known = (req.method === 'GET' && route === '/version') ||
        ((req.method === 'POST' || req.method === 'PUT') && route === '/version/check');
      res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(known ? VERSION : { error: 'no such endpoint' }));
    });
  });
  fakes.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); });
  return { socket, seen, bodies };
}

async function dashboard(env: NodeJS.ProcessEnv): Promise<WebServer> {
  const app = await startWebServer({
    // Only what `/api/session` touches: it asks whether this installation is
    // in recovery, and these tests care about the version beside that answer.
    pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never, registry: new ToolRegistry(), catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture', env,
  });
  servers.push(app);
  return app;
}

/** A session, and the headers every write in these tests carries. */
async function open(app: WebServer): Promise<{ origin: string; headers: Record<string, string>; session: Record<string, unknown> }> {
  const origin = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${origin}/api/session`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  return {
    origin,
    headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' },
    session: (await res.json()) as Record<string, unknown>,
  };
}

it('forwards every verb to the supervisor and says the two things the page needs', async () => {
  const { socket, seen, bodies } = await fakeSupervisor();
  const app = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket });
  const { origin, headers, session } = await open(app);

  // The session carries the running version, which is how the page tells a
  // gateway that came back upgraded from one that never went away.
  expect(typeof session.version).toBe('string');
  expect(session.version).not.toBe('');

  const view = await fetch(`${origin}/api/version`, { headers });
  expect(view.status).toBe(200);
  expect(await view.json()).toEqual({ ...VERSION, supervised: true, checkout: false });

  const checked = await fetch(`${origin}/api/version/check`, { method: 'POST', headers });
  expect(checked.status).toBe(200);
  expect(await checked.json()).toEqual({ ...VERSION, supervised: true, checkout: false });

  const switched = await fetch(`${origin}/api/version/check`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
  expect(switched.status).toBe(200);
  expect(bodies).toContain('{"enabled":false}');

  // An upgrade is accepted, not completed: the gateway it takes down is this one.
  const started = await fetch(`${origin}/api/upgrade`, { method: 'POST', headers, body: JSON.stringify({ version: '0.1.1' }) });
  expect(started.status).toBe(202);
  expect(await started.json()).toEqual({ job: JOB });
  expect(bodies).toContain('{"version":"0.1.1"}');

  const job = await fetch(`${origin}/api/upgrade/jobs/${JOB.id}`, { headers });
  expect(job.status).toBe(200);
  expect(await job.json()).toMatchObject({ phase: 'installing' });

  expect(seen).toEqual([
    'GET /version',
    'POST /version/check',
    'PUT /version/check',
    'POST /upgrade',
    `GET /jobs/${JOB.id}`,
  ]);
});

it('refuses a switch that is not a boolean, and never asks the supervisor', async () => {
  const { socket, seen } = await fakeSupervisor();
  const app = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket });
  const { origin, headers } = await open(app);
  const bad = await fetch(`${origin}/api/version/check`, { method: 'PUT', headers, body: JSON.stringify({ enabled: 'yes' }) });
  expect(bad.status).toBe(400);
  expect(seen).toEqual([]);
});

it('keeps the gate: no session, no CSRF, no foreign origin', async () => {
  const { socket } = await fakeSupervisor();
  const app = await dashboard({ BUDDI_SUPERVISOR_SOCKET: socket });
  const { origin, headers } = await open(app);
  expect((await fetch(`${origin}/api/version`, { headers: { 'X-Forwarded-For': '100.64.0.2' } })).status).toBe(401);
  for (const changed of [{ ...headers, 'X-Buddi-CSRF': '' }, { ...headers, Origin: 'https://untrusted.example' }]) {
    expect((await fetch(`${origin}/api/upgrade`, { method: 'POST', headers: changed, body: '{}' })).status).toBe(403);
  }
});

it('falls back to what the last supervisor wrote down when the socket has gone', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-upgrade-data-'));
  await writeFile(path.join(data, 'upgrade.json'), JSON.stringify({
    check: { enabled: true, lastAt: '2026-01-02T03:04:05.000Z', latest: '0.1.1' },
    current: '0.1.1',
    history: [{ from: '0.1.0', to: '0.1.1', startedAt: '2026-01-02T03:05:00.000Z', finishedAt: '2026-01-02T03:06:00.000Z', outcome: 'done', backup: 'buddi-backup-20260102-030500.tar.gz' }],
  }), 'utf8');
  // A socket path nothing is listening on: exactly the middle of an upgrade.
  const app = await dashboard({ BUDDI_SUPERVISOR_SOCKET: path.join(data, 'gone.sock'), BUDDI_DATA_DIR: data });
  const { origin, headers } = await open(app);
  const view = await fetch(`${origin}/api/version`, { headers });
  expect(view.status).toBe(200);
  expect(await view.json()).toEqual({
    current: '0.1.1',
    latest: '0.1.1',
    checkedAt: '2026-01-02T03:04:05.000Z',
    checkEnabled: true,
    // The newest is what is running now, so there is nothing to offer.
    updateAvailable: false,
    history: [{ from: '0.1.0', to: '0.1.1', startedAt: '2026-01-02T03:05:00.000Z', finishedAt: '2026-01-02T03:06:00.000Z', outcome: 'done', backup: 'buddi-backup-20260102-030500.tar.gz' }],
    supervised: true,
    checkout: false,
  });
});

it('says 503 when there is neither a supervisor answering nor a record on disk', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-upgrade-empty-'));
  const app = await dashboard({ BUDDI_SUPERVISOR_SOCKET: path.join(data, 'gone.sock'), BUDDI_DATA_DIR: data });
  const { origin, headers } = await open(app);
  expect((await fetch(`${origin}/api/version`, { headers })).status).toBe(503);
});

it('reports a checkout as a checkout, and refuses to upgrade one', async () => {
  const app = await dashboard({});
  const { origin, headers } = await open(app);
  const view = await fetch(`${origin}/api/version`, { headers });
  expect(view.status).toBe(200);
  const body = await view.json() as { current: string; checkout: boolean; supervised: boolean; updateAvailable: boolean; history: unknown[] };
  expect(body).toMatchObject({ checkout: true, supervised: false, updateAvailable: false, history: [] });
  // The workspace's version, and in a checkout with a .git the commit after it.
  expect(body.current).toMatch(/^\d+\.\d+\.\d+/);

  for (const route of ['/api/version/check', '/api/upgrade']) {
    const refused = await fetch(`${origin}${route}`, { method: 'POST', headers, body: '{}' });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toContain('git pull');
  }
});
