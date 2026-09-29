import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isMlxhAccount, MLXH_BASE_URL } from '@buddi/core';
import { mlxhBaseUrl, mlxhWindow, probeMlxh } from './mlxh.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A fake mlxh: answers the two read-only routes, and fails the test on anything else. */
async function fakeMlxh(routes: Record<string, unknown>): Promise<{ baseUrl: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const body = routes[req.url ?? ''];
    if (req.method !== 'GET' || body === undefined) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

/** What a v0.2 manager answers, trimmed from a real one. */
const managerInfo = {
  model: null, model_kind: 'manager', manager: true,
  models: ['bonsai2', 'gemma4-e2b', 'gemma4-e2b-it', 'klein', 'openjev'],
  workers: [
    { model: 'gemma4-e2b-it', state: 'idle', active_requests: 0, model_kind: 'language', pid: 1, queue_depth: 0 },
    { model: 'klein', state: 'idle', active_requests: 0, model_kind: 'image', pid: 2, queue_depth: 0 },
  ],
  worker_idle_timeout_s: 300.0,
};
const managerModels = { object: 'list', data: managerInfo.models.map((id) => ({ id, object: 'model', owned_by: 'mlxh' })) };

describe('probeMlxh', () => {
  it('lists every installed model on a manager, which are loaded, and what the loaded ones are', async () => {
    const fake = await fakeMlxh({ '/mlxh/info': managerInfo, '/v1/models': managerModels });
    const probe = await probeMlxh({ baseUrl: fake.baseUrl });
    expect(probe).toEqual({
      running: true, baseUrl: fake.baseUrl, manager: true,
      models: [
        { id: 'bonsai2', loaded: false },
        { id: 'gemma4-e2b', loaded: false },
        { id: 'gemma4-e2b-it', loaded: true, kind: 'language' },
        { id: 'klein', loaded: true, kind: 'image' },
        { id: 'openjev', loaded: false },
      ],
      workerIdleTimeoutS: 300,
    });
    // Read-only: the two GETs and nothing else, never a prompt.
    expect(fake.seen.sort()).toEqual(['GET /mlxh/info', 'GET /v1/models']);
    // The manager does not report its limit: mlxh's default stands in.
    expect(mlxhWindow(probe)).toBe(8192);
  });

  it('reads a pinned server\'s own max_prompt_tokens', async () => {
    const fake = await fakeMlxh({
      '/mlxh/info': { model: 'bonsai2', model_kind: 'language', settings: { max_queued: 4, max_tokens_cap: 16384, max_prompt_tokens: 40960 } },
      '/v1/models': { data: [{ id: 'bonsai2' }] },
    });
    const probe = await probeMlxh({ baseUrl: fake.baseUrl });
    expect(probe).toMatchObject({ running: true, manager: false, models: [{ id: 'bonsai2', loaded: true, kind: 'language' }], maxPromptTokens: 40960 });
    expect(mlxhWindow(probe)).toBe(40960);
    // 0 is "off": the model's own window decides, not a number from here.
    expect(mlxhWindow({ maxPromptTokens: 0 })).toBeNull();
  });

  it('says not running, never throws, when nothing answers or it answers nonsense', async () => {
    const closed = await fakeMlxh({});
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await probeMlxh({ baseUrl: closed.baseUrl })).toEqual({ running: false, baseUrl: closed.baseUrl, manager: false, models: [] });
    const nothing = await fakeMlxh({});
    expect(await probeMlxh({ baseUrl: nothing.baseUrl })).toMatchObject({ running: false, models: [] });
  });

  it('gives up after its timeout on a server that accepts and never answers', async () => {
    const idle = createServer(() => { /* never answers */ });
    servers.push(idle);
    await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(idle.address() as AddressInfo).port}/v1`;
    const started = Date.now();
    expect(await probeMlxh({ baseUrl, timeoutMs: 200 })).toMatchObject({ running: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    idle.closeAllConnections();
  });
});

describe('mlxh addresses', () => {
  it('takes MLXH_BASE_URL over the default', () => {
    expect(mlxhBaseUrl({})).toBe(MLXH_BASE_URL);
    expect(mlxhBaseUrl({ MLXH_BASE_URL: 'http://127.0.0.1:2000/v1/' })).toBe('http://127.0.0.1:2000/v1');
  });

  it('recognises an mlxh account by its address, on any loopback name for port 1060', () => {
    expect(isMlxhAccount({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1060/v1' })).toBe(true);
    expect(isMlxhAccount({ kind: 'openai-compatible', baseUrl: 'http://localhost:1060/v1/' })).toBe(true);
    expect(isMlxhAccount({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:2000/v1' }, 'http://127.0.0.1:2000/v1')).toBe(true);
    expect(isMlxhAccount({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe(false);
    expect(isMlxhAccount({ kind: 'openai', baseUrl: 'http://127.0.0.1:1060/v1' })).toBe(false);
  });
});
