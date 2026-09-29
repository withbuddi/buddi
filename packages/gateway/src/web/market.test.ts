/**
 * `/api/market`: fetched only when asked, kept a day, and honest when
 * withbuddi.com does not answer. A local server stands in for the site.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marketFile, marketRoute, resetMarketCache } from './market.js';

const weather = {
  name: 'weather',
  npm: '@withbuddi/plugin-weather',
  version: '0.2.0',
  title: 'Weather',
  summary: 'The weather for the places you save.',
  category: 'days',
  trust: 'by-buddi',
  pricing: { kind: 'free' },
  page: 'https://withbuddi.com/plugins/weather',
  claims: { package: { uses: ['http', 'owner:notify', 'not-an-area'] }, manifest: { network: [{ host: 'api.open-meteo.com' }] } },
};
const finance = { ...weather, name: 'finance', npm: '@withbuddi/plugin-finance', version: '1.0.0', title: 'Finance', category: 'money' };

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server | undefined;
let hits = 0;
let answer: () => { status: number; body: unknown } = () => ({ status: 200, body: { plugins: [weather, finance] } });
const logs: string[] = [];
const log = (line: string): void => void logs.push(line);

async function start(): Promise<string> {
  server = createServer((req, res) => {
    hits += 1;
    if (req.url !== '/plugins/index.json') {
      res.writeHead(404).end();
      return;
    }
    const { status, body } = answer();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

const route = (query = '', now?: Date) =>
  marketRoute({ env, log, ...(now === undefined ? {} : { now: () => now }) }, new URL(`http://x/api/market${query}`));

beforeEach(async () => {
  resetMarketCache();
  hits = 0;
  logs.length = 0;
  answer = () => ({ status: 200, body: { plugins: [weather, finance] } });
  root = mkdtempSync(path.join(tmpdir(), 'buddi-market-'));
  env = {
    BUDDI_DATA_DIR: path.join(root, 'data'),
    BUDDI_AGENTS_DIR: path.join(root, 'agents'),
    BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
    BUDDI_MARKET_URL: await start(),
  };
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/market', () => {
  it('fetches the list, keeps unknown fields, and keeps a copy on disk', async () => {
    const reply = await route();
    expect(reply.status).toBe(200);
    const body = reply.body as { fetchedAt: string; plugins: Array<Record<string, unknown>>; stale?: boolean };
    expect(body.stale).toBeUndefined();
    expect(body.plugins.map((p) => p.name)).toEqual(['weather', 'finance']);
    expect(body.plugins[0]?.page).toBe('https://withbuddi.com/plugins/weather');
    expect(body.plugins[0]?.usesWords).toEqual([
      { use: 'http', words: 'sends web requests' },
      { use: 'owner:notify', words: 'can send you messages when you are away' },
    ]);
    expect(hits).toBe(1);
    const disk = JSON.parse(readFileSync(marketFile(env), 'utf8'));
    expect(disk.fetchedAt).toBe(body.fetchedAt);
    expect(disk.index.plugins).toHaveLength(2);
  });

  it('answers from its copy for a day, and refetches on refresh=1', async () => {
    await route();
    await route();
    expect(hits).toBe(1);
    // A new process: memory is gone, the disk copy answers.
    resetMarketCache();
    await route();
    expect(hits).toBe(1);
    await route('?refresh=1');
    expect(hits).toBe(2);
    // A day later it asks again.
    await route('', new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(hits).toBe(3);
  });

  it('answers the old copy, marked stale, when the site fails', async () => {
    await route();
    answer = () => ({ status: 500, body: {} });
    const reply = await route('?refresh=1');
    const body = reply.body as { stale?: boolean; plugins: unknown[] };
    expect(reply.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.plugins).toHaveLength(2);
  });

  it('says it could not reach withbuddi.com when it has nothing', async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const reply = await route();
    expect(reply.status).toBe(200);
    const body = reply.body as { plugins: unknown[]; unavailable: string };
    expect(body.plugins).toEqual([]);
    expect(body.unavailable).toMatch(/^buddi could not reach withbuddi\.com: /);
    expect(existsSync(marketFile(env))).toBe(false);
  });

  it('refuses a body that is not a plugin list, and leaves out a bad listing', async () => {
    answer = () => ({ status: 200, body: { hello: 'world' } });
    const bad = (await route()).body as { unavailable: string };
    expect(bad.unavailable).toContain('not a plugin list');
    answer = () => ({ status: 200, body: { plugins: [weather, { name: 'half' }] } });
    const some = (await route('?refresh=1')).body as { plugins: Array<{ name: string }> };
    expect(some.plugins.map((p) => p.name)).toEqual(['weather']);
  });

  it('marks what is installed, and what has a newer listed version', async () => {
    writeFileSync(
      env.BUDDI_PLUGINS_FILE as string,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            name: 'weather',
            version: '0.1.0',
            entry: '/nowhere/index.js',
            schema: 'weather',
            installedAt: '2026-09-28T00:00:00.000Z',
            source: { kind: 'registry', name: '@withbuddi/plugin-weather', version: '0.1.0' },
          },
          {
            name: 'money',
            version: '1.0.0',
            entry: '/nowhere/index.js',
            schema: 'finance',
            installedAt: '2026-09-28T00:00:00.000Z',
            source: { kind: 'registry', name: '@withbuddi/plugin-finance', version: '1.0.0' },
          },
        ],
      }),
    );
    const body = (await route()).body as { plugins: Array<Record<string, unknown>> };
    expect(body.plugins[0]).toMatchObject({ installed: { version: '0.1.0' }, update: '0.2.0' });
    expect(body.plugins[1]).toMatchObject({ installed: { version: '1.0.0' } });
    expect(body.plugins[1]?.update).toBeUndefined();
  });
});
