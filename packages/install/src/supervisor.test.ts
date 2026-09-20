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
function call(socket: string, route: string, method = 'GET', headers: Record<string, string> = { host: 'localhost' }): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: route, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) }));
    });
    req.once('error', reject);
    req.end();
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

  test('gateway restart backoff is exponential and bounded', () => {
    expect([0, 1, 2, 3, 4, 1000].map(restartDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
