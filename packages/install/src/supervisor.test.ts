import { lstat, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { controlSocket, listenOnSocket, restartDelay, supervisorSocket, type SupervisorStatus } from './supervisor.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

const STATUS: SupervisorStatus = {
  phase: 'ready', supervisorPid: 1, installRoot: '/install', nodePath: '/node',
  database: 'running', databasePid: 2, gateway: 'running', gatewayPid: 3,
};

/** The only client shape there is: a request on the socket, never on a port. */
function call(socket: string, route: string, method = 'GET', headers: Record<string, string> = { host: 'localhost' }, body?: unknown): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: route, method, headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

async function serve(action = vi.fn(async (_name: string) => {})): Promise<{ socket: string; action: typeof action }> {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-supervisor-'));
  const socket = supervisorSocket(data);
  const server = controlSocket({ status: () => STATUS, action });
  servers.push(server);
  await listenOnSocket(server, socket);
  return { socket, action };
}

describe('the supervisor', () => {
  test('serves status and the three actions on an owner-only socket', async () => {
    const { socket, action } = await serve();
    expect(path.basename(socket)).toBe('supervisor.sock');
    // The filesystem is the whole credential, so the mode is the whole check.
    expect(((await stat(socket)).mode & 0o777).toString(8)).toBe('600');
    expect(await call(socket, '/status')).toEqual({ status: 200, body: STATUS });
    // `start` and `stop` are answered once they are done: neither kills its
    // client, and `buddi service stop` prints the status it is given.
    expect(await call(socket, '/start', 'POST')).toEqual({ status: 200, body: STATUS });
    expect(await call(socket, '/stop', 'POST')).toEqual({ status: 200, body: STATUS });
    // `restart` replaces the gateway that asked, so it is acknowledged first
    // and carried out after: a reply composed afterwards would reach nobody.
    expect(await call(socket, '/restart', 'POST')).toEqual({ status: 202, body: STATUS });
    expect(action.mock.calls.map(([name]) => name)).toEqual(['start', 'stop', 'restart']);
  });

  test('exposes nothing else: no page, no redirect, no other method', async () => {
    const { socket, action } = await serve();
    for (const [route, method] of [['/', 'GET'], ['/dashboard', 'GET'], ['/status', 'POST'], ['/start', 'GET'], ['/../etc', 'GET']] as const) {
      expect((await call(socket, route, method)).status).toBe(404);
    }
    expect(action).not.toHaveBeenCalled();
  });

  test('refuses a request claiming some other host', async () => {
    const { socket, action } = await serve();
    expect((await call(socket, '/start', 'POST', { host: 'attacker.example' })).status).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });

  test('replaces the socket a killed supervisor left behind', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-supervisor-'));
    const socket = supervisorSocket(data);
    // A process killed while listening leaves its socket file behind; a clean
    // close would remove it, so the stale file has to come from a real kill.
    spawnSync(process.execPath, ['-e', `require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))`, socket]);
    expect((await lstat(socket)).isSocket()).toBe(true);
    const server = controlSocket({ status: () => STATUS, action: async () => {} });
    servers.push(server);
    await listenOnSocket(server, socket);
    expect((await call(socket, '/status')).status).toBe(200);
  });

  test('refuses to replace something at the socket path that is not a socket', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-supervisor-'));
    const socket = supervisorSocket(data);
    await writeFile(socket, 'not a socket');
    const server = controlSocket({ status: () => STATUS, action: async () => {} });
    servers.push(server);
    await expect(listenOnSocket(server, socket)).rejects.toThrow(/not a socket/);
    expect(await readFile(socket, 'utf8')).toBe('not a socket');
  });

  test('serves the version and upgrade verbs, and nothing else about them', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-supervisor-'));
    const socket = supervisorSocket(data);
    const view = { current: '0.1.0', latest: '0.1.1', checkEnabled: true, updateAvailable: true, history: [] };
    const job = { id: '11111111-1111-4111-8111-111111111111', kind: 'upgrade', phase: 'backup', phases: ['starting', 'backup'], startedAt: 'now' };
    const upgrade = {
      view: vi.fn(async () => view),
      check: vi.fn(async () => view),
      setCheckEnabled: vi.fn(async (enabled: boolean) => ({ ...view, checkEnabled: enabled })),
      start: vi.fn(() => job),
      job: vi.fn((id: string) => (id === job.id ? job : undefined)),
      busy: vi.fn(() => false),
      tick: vi.fn(async () => {}),
      current: '0.1.0',
    };
    const server = controlSocket({ status: () => STATUS, action: async () => {}, upgrade: upgrade as never });
    servers.push(server);
    await listenOnSocket(server, socket);

    expect(await call(socket, '/version')).toEqual({ status: 200, body: view });
    expect(await call(socket, '/version/check', 'POST')).toEqual({ status: 200, body: view });
    expect((await call(socket, '/version/check', 'PUT', { host: 'localhost' }, { enabled: false })).body).toMatchObject({ checkEnabled: false });
    // The switch is a boolean, and nothing else is accepted for it.
    expect((await call(socket, '/version/check', 'PUT', { host: 'localhost' }, { enabled: 'yes' })).status).toBe(400);
    expect(await call(socket, '/upgrade', 'POST', { host: 'localhost' }, { version: '0.1.1' })).toEqual({ status: 202, body: { job } });
    expect(upgrade.start).toHaveBeenCalledWith('0.1.1');
    // One job route for both stores, so a client polls what it was handed.
    expect((await call(socket, `/jobs/${job.id}`)).body).toEqual(job);
    expect((await call(socket, '/version', 'DELETE')).status).toBe(404);

    // While an upgrade runs, the gateway levers belong to it.
    upgrade.busy.mockReturnValue(true);
    expect(await call(socket, '/restart', 'POST')).toEqual({ status: 409, body: { error: 'An upgrade is running.' } });
    expect((await call(socket, '/upgrade', 'POST', { host: 'localhost' }, {})).status).toBe(202);
  });

  test('has no version verbs at all when the supervisor has no installation', async () => {
    const { socket } = await serve();
    expect((await call(socket, '/version')).status).toBe(404);
    expect((await call(socket, '/upgrade', 'POST')).status).toBe(404);
  });

  test('gateway restart backoff is exponential and bounded', () => {
    expect([0, 1, 2, 3, 4, 1000].map(restartDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
