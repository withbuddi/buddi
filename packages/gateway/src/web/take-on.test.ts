/**
 * First run, chapter 3: the outcomes the owner ticks, installed in the
 * background, and approved on the owner's behalf only for By-buddi listings
 * whose staged integrity is exactly the one the market lists.
 *
 * A local server stands in for withbuddi.com (`BUDDI_MARKET_URL`), and npm is
 * a fake that answers from a fixture on disk: nothing here reaches the
 * network, the owner's record or the live database.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPluginsFile } from '@buddi/core';
import { resetMarketCache } from './market.js';
import { pluginJobRoute } from './plugins.js';
import { approveStaged } from '../plugins/approve.js';
import { resetAdoptedPlugins } from '../plugins/load.js';
import { integrityOfFile, rejectStaged, stagePlugin } from '../plugins/stage.js';
import type { NpmRunner } from '../plugins/npm.js';
import {
  autoApprovalRefusal,
  offeredTiles,
  parseTiles,
  readTakeOnOffers,
  readTakeOn,
  resetTakeOn,
  startTakeOn,
  takeOnSettled,
  TakeOnRefusal,
  type TakeOnDeps,
  type TakeOnEngine,
} from './take-on.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER_FIXTURE = path.join(HERE, '..', 'plugins', 'fixtures', 'marker-plugin');
const ZOD_DIR = path.dirname(createRequire(import.meta.url).resolve('zod/package.json'));

const listing = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  npm: `@withbuddi/plugin-${name}`,
  version: '0.1.0',
  title: name.charAt(0).toUpperCase() + name.slice(1),
  summary: '',
  category: 'days',
  trust: 'by-buddi',
  pricing: { kind: 'free' },
  integrity: `sha512-${name}`,
  ...over,
});

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server | undefined;
let index: () => { status: number; body: unknown };
const temporary: string[] = [];
const logs: string[] = [];

async function start(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url !== '/plugins/index.json') return void res.writeHead(404).end();
    const { status, body } = index();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

/** Just enough of `core.onboarding` for the store's own statements. */
function fakePool() {
  const row = {
    owner_id: 'owner', state: 'pending', started_at: null, completed_at: null, surface: null as string | null,
    steps_done: [] as string[], details: {} as Record<string, unknown>, nudges_sent: 0, last_nudge_at: null,
    unanswered: 0, quiet_until: null, updated_at: null,
  };
  return {
    row,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/select .* from core\.onboarding/s.test(sql)) return { rows: [row] };
      if (/insert into core\.onboarding/.test(sql)) {
        if (/values \(\$1, 'in-progress'/.test(sql)) {
          if (row.state === 'pending') row.state = 'in-progress';
        } else if (/\(owner_id, details, updated_at\)/.test(sql)) {
          row.details = { ...row.details, ...(JSON.parse(String(params[1])) as Record<string, unknown>) };
        } else {
          const step = String(params[1]);
          if (!row.steps_done.includes(step)) row.steps_done = [...row.steps_done, step];
        }
        return { rows: [row] };
      }
      return { rows: [] };
    }),
  };
}

/** An engine that stages instantly with the integrity it is told, and records what it was asked. */
function fakeEngine(integrityOf: (spec: string) => string = (spec) => `sha512-${/plugin-([a-z]+)@/.exec(spec)?.[1]}`) {
  const calls = { staged: [] as string[], approved: [] as Array<{ id: string; integrity: string }>, rejected: [] as string[], enabled: [] as string[] };
  const api = {
    stagePlugin: vi.fn(async (spec: string, opts: { onPhase?: (phase: string) => void }) => {
      calls.staged.push(spec);
      opts.onPhase?.('fetching');
      opts.onPhase?.('reading');
      const name = /plugin-([a-z]+)@/.exec(spec)?.[1] ?? 'x';
      return { id: `stage-${name}`, name, version: '0.1.0', integrity: integrityOf(spec) };
    }),
    approveStaged: vi.fn(async (id: string, opts: { integrity: string }) => {
      calls.approved.push({ id, integrity: opts.integrity });
      return { kind: 'installed', record: { name: id.replace('stage-', '') }, plan: {}, restartNeeded: true, migrations: [] };
    }),
    rejectStaged: vi.fn((id: string) => {
      calls.rejected.push(id);
      return true;
    }),
    setPluginEnabled: vi.fn(async (name: string) => {
      calls.enabled.push(name);
      return { name, enabled: true, changed: false, missions: [], restartNeeded: false };
    }),
  };
  return { api: api as unknown as TakeOnEngine, calls };
}

const registry = { register: vi.fn(), unregister: vi.fn(), manifests: vi.fn(() => []) } as never;

function deps(pool: ReturnType<typeof fakePool>, over: Partial<TakeOnDeps> = {}): TakeOnDeps {
  return { pool: pool as never, env, log: (line) => void logs.push(line), ...over };
}

beforeEach(async () => {
  resetMarketCache();
  resetTakeOn();
  resetAdoptedPlugins();
  logs.length = 0;
  index = () => ({ status: 200, body: { plugins: [listing('weather'), listing('calendar'), listing('finance'), listing('speech'), listing('image')] } });
  root = mkdtempSync(path.join(tmpdir(), 'buddi-take-on-'));
  mkdirSync(path.join(root, 'agents'), { recursive: true });
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  env = {
    ...process.env,
    BUDDI_DATA_DIR: path.join(root, 'data'),
    BUDDI_AGENTS_DIR: path.join(root, 'agents'),
    BUDDI_SKILLS_DIR: path.join(root, 'skills'),
    BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
    BUDDI_MARKET_URL: await start(),
  };
  process.env.BUDDI_FIXTURE_MARKER = path.join(root, 'marker.txt');
});

afterEach(async () => {
  await takeOnSettled();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  resetAdoptedPlugins();
  delete process.env.BUDDI_FIXTURE_MARKER;
  rmSync(root, { recursive: true, force: true });
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the tiles', () => {
  it('takes the six outcomes in the chapter order, each once, and refuses anything else', () => {
    expect(parseTiles(['mail', 'days', 'mail'])).toEqual(['days', 'mail']);
    expect(parseTiles([])).toEqual([]);
    expect(() => parseTiles(['days', 'garden'])).toThrow(TakeOnRefusal);
    expect(() => parseTiles('days')).toThrow(/list/);
  });

  it('records the choice as the take-on step, an empty list included', async () => {
    const pool = fakePool();
    const { api } = fakeEngine();
    expect(await startTakeOn(deps(pool, { engine: api }), [])).toEqual({ jobs: [] });
    expect(pool.row.steps_done).toContain('take-on');
    expect(pool.row.details.takeOn).toEqual([]);
    expect((await readTakeOn(deps(pool))).tiles).toEqual([]);
  });
});

describe('the tiles offered', () => {
  it('drops My code while withbuddi.com does not list the developer plugin, and keeps My mail', async () => {
    expect(await readTakeOnOffers({ env, log: (line) => void logs.push(line) })).toEqual(['days', 'mail', 'money', 'voice', 'pictures']);
  });

  it('offers My code once the developer plugin is listed, and drops a tile whose plugin is missing', async () => {
    index = () => ({ status: 200, body: { plugins: [listing('weather'), listing('finance'), listing('developer')] } });
    expect(await readTakeOnOffers({ env, log: () => {} })).toEqual(['mail', 'money', 'code']);
  });

  it('falls back to the plugins known published, never developer, when withbuddi.com cannot be reached', async () => {
    index = () => ({ status: 503, body: {} });
    expect(await readTakeOnOffers({ env, log: () => {} })).toEqual(['days', 'mail', 'money', 'voice', 'pictures']);
    expect(offeredTiles(undefined)).not.toContain('code');
  });

  it('does not wait on a slow withbuddi.com, and never reaches it when asked for the kept copy only', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    expect(await readTakeOnOffers({ env, log: () => {}, fetch: fetch as never }, { timeoutMs: 20 })).toEqual(['days', 'mail', 'money', 'voice', 'pictures']);
    const never = vi.fn();
    expect(await readTakeOnOffers({ env, log: () => {}, fetch: never as never }, { cachedOnly: true })).not.toContain('code');
    expect(never).not.toHaveBeenCalled();
  });
});

describe('installing in the background', () => {
  it('answers at once with a job per plugin, then stages, approves with the staged integrity and loads live', async () => {
    const pool = fakePool();
    const { api, calls } = fakeEngine();
    const answer = await startTakeOn(deps(pool, { engine: api, registry }), ['days', 'mail']);
    expect(answer.jobs.map((j) => j.plugin)).toEqual(['weather', 'calendar']);
    // The jobs are the plugin jobs the Plugins page already watches.
    expect(pluginJobRoute({ env, log: () => {} }, answer.jobs[0]!.jobId).status).toBe(200);
    await takeOnSettled();
    expect(calls.staged).toEqual(['@withbuddi/plugin-weather@0.1.0', '@withbuddi/plugin-calendar@0.1.0']);
    expect(calls.approved).toEqual([
      { id: 'stage-weather', integrity: 'sha512-weather' },
      { id: 'stage-calendar', integrity: 'sha512-calendar' },
    ]);
    expect(calls.enabled).toEqual(['weather', 'calendar']);
    const view = await readTakeOn(deps(pool, { agentIds: () => [] }));
    expect(view.running).toBe(false);
    expect(view.plugins.map((p) => [p.plugin, p.state])).toEqual([['weather', 'ready'], ['calendar', 'ready']]);
    expect((pluginJobRoute({ env, log: () => {} }, answer.jobs[0]!.jobId).body as { phase: string }).phase).toBe('done');
  });

  it('says what is still running while it runs', async () => {
    const pool = fakePool();
    const { api } = fakeEngine();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { ...api, stagePlugin: vi.fn(async (spec: string, opts: never) => { await gate; return (api.stagePlugin as never as (s: string, o: never) => Promise<unknown>)(spec, opts); }) } as unknown as TakeOnEngine;
    await startTakeOn(deps(pool, { engine: slow }), ['money']);
    const during = await readTakeOn(deps(pool));
    expect(during.running).toBe(true);
    expect(during.plugins[0]).toMatchObject({ plugin: 'finance', state: 'fetching' });
    release();
    await takeOnSettled();
    expect((await readTakeOn(deps(pool))).running).toBe(false);
  });

  it('never approves a listing that is not By-buddi, and never stages it', async () => {
    index = () => ({ status: 200, body: { plugins: [listing('finance', { trust: 'reviewed' })] } });
    const pool = fakePool();
    const { api, calls } = fakeEngine();
    await startTakeOn(deps(pool, { engine: api }), ['money']);
    await takeOnSettled();
    expect(calls.staged).toEqual([]);
    expect(calls.approved).toEqual([]);
    const view = await readTakeOn(deps(pool));
    expect(view.plugins[0]).toMatchObject({ state: 'failed' });
    expect(view.plugins[0]!.reason).toMatch(/not made by buddi/);
    expect(view.waiting.some((line) => line.startsWith('Finance did not install'))).toBe(true);
  });

  it('refuses bytes whose integrity is not the one the market lists, and rejects the stage', async () => {
    const pool = fakePool();
    const { api, calls } = fakeEngine(() => 'sha512-something-else');
    await startTakeOn(deps(pool, { engine: api }), ['voice']);
    await takeOnSettled();
    expect(calls.staged).toEqual(['@withbuddi/plugin-speech@0.1.0']);
    expect(calls.approved).toEqual([]);
    expect(calls.rejected).toEqual(['stage-speech']);
    expect((await readTakeOn(deps(pool))).plugins[0]).toMatchObject({ state: 'failed' });
  });

  it('refuses a listing that names no integrity', () => {
    expect(autoApprovalRefusal(listing('image', { integrity: undefined }) as never)).toMatch(/without its hash/);
    expect(autoApprovalRefusal(undefined)).toMatch(/does not list it/);
    expect(autoApprovalRefusal(listing('image') as never)).toBeNull();
  });

  it('says so, and blocks nothing, when withbuddi.com does not answer', async () => {
    index = () => ({ status: 503, body: {} });
    const pool = fakePool();
    const { api, calls } = fakeEngine();
    await startTakeOn(deps(pool, { engine: api }), ['pictures']);
    await takeOnSettled();
    expect(calls.staged).toEqual([]);
    const view = await readTakeOn(deps(pool));
    expect(view.plugins[0]).toMatchObject({ plugin: 'image', state: 'failed' });
    expect(view.waiting).toContain('Image did not install: withbuddi.com did not answer. Settings → Plugins can fetch it later');
  });

  it('says a plugin it could not load live wakes up on the next restart', async () => {
    const pool = fakePool();
    const { api } = fakeEngine();
    await startTakeOn(deps(pool, { engine: api }), ['days']);
    await takeOnSettled();
    const view = await readTakeOn(deps(pool, { agentIds: () => [] }));
    expect(view.plugins.every((p) => p.wakesOnRestart === true)).toBe(true);
    expect(view.waiting).toContain('Weather is installed; it wakes up on the next restart');
  });
});

describe('what is still waiting', () => {
  it('names the mailbox, the calendar link and the teammates ready to be introduced, and nothing is created', async () => {
    const pool = fakePool();
    const { api } = fakeEngine();
    await startTakeOn(deps(pool, { engine: api, registry }), ['days', 'mail', 'money']);
    await takeOnSettled();
    const view = await readTakeOn(deps(pool, { mailboxSet: async () => false, agentIds: () => ['concierge'] }));
    expect(view.waiting).toEqual([
      'Mail Triage is waiting for a mailbox',
      'Calendar wants your calendar’s private link',
    ]);
    // A mailbox: that line goes. (Planner, Ledger and Illustrator are catalogue packages now, not a tile's teammate.)
    const later = await readTakeOn(deps(pool, { mailboxSet: async () => true, agentIds: () => ['planner'] }));
    expect(later.waiting).toEqual([
      'Calendar wants your calendar’s private link',
      'Mail Triage is ready to be introduced',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The real engine, with an npm that answers from a fixture on disk
 * ------------------------------------------------------------------ */

function packFixture(into: string): string {
  const staging = mkdtempSync(path.join(tmpdir(), 'buddi-pack-'));
  cpSync(MARKER_FIXTURE, path.join(staging, 'package'), { recursive: true });
  mkdirSync(into, { recursive: true });
  const tgz = path.join(into, 'fixture.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', staging, 'package']);
  rmSync(staging, { recursive: true, force: true });
  return tgz;
}

function fakeNpm(tarball: string): NpmRunner {
  const name = JSON.parse(readFileSync(path.join(MARKER_FIXTURE, 'package.json'), 'utf8')).name as string;
  const version = JSON.parse(readFileSync(path.join(MARKER_FIXTURE, 'package.json'), 'utf8')).version as string;
  return {
    async view(): Promise<any> {
      return { name, version, dist: { integrity: integrityOfFile(tarball), tarball: `https://registry.invalid/${name}` }, _npmUser: { name: 'withbuddi' } };
    },
    async pack(_spec, destination): Promise<string> {
      mkdirSync(destination, { recursive: true });
      const into = path.join(destination, 'fixture.tgz');
      copyFileSync(tarball, into);
      return into;
    },
    async install(dir): Promise<void> {
      const modules = path.join(dir, 'node_modules');
      mkdirSync(modules, { recursive: true });
      if (!existsSync(path.join(modules, 'zod'))) symlinkSync(ZOD_DIR, path.join(modules, 'zod'), 'junction');
    },
  };
}

describe('with the real staging and approval', () => {
  const realEngine = (npm: NpmRunner): TakeOnEngine =>
    ({
      stagePlugin: (spec: string, opts: Record<string, unknown>) => stagePlugin(spec, { ...opts, npm }),
      approveStaged,
      rejectStaged,
    }) as unknown as TakeOnEngine;

  it('installs a By-buddi listing whose tarball hashes to the listed integrity, with its hash on the record', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-fake-npm-'));
    temporary.push(dir);
    const tarball = packFixture(dir);
    const integrity = integrityOfFile(tarball);
    index = () => ({ status: 200, body: { plugins: [listing('weather', { npm: 'buddi-plugin-fixture-marker', version: '1.0.0', integrity })] } });
    const pool = fakePool();
    await startTakeOn(deps(pool, { engine: realEngine(fakeNpm(tarball)) }), ['days']);
    await takeOnSettled();
    const record = readPluginsFile(env.BUDDI_PLUGINS_FILE!).plugins;
    expect(record).toHaveLength(1);
    expect(record[0]!.provenance?.integrity).toBe(integrity);
    expect((await readTakeOn(deps(pool))).plugins[0]).toMatchObject({ plugin: 'weather', state: 'ready', wakesOnRestart: true });
  });

  it('installs nothing when the listed integrity is not the tarball’s', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-fake-npm-'));
    temporary.push(dir);
    const tarball = packFixture(dir);
    index = () => ({ status: 200, body: { plugins: [listing('weather', { npm: 'buddi-plugin-fixture-marker', version: '1.0.0', integrity: 'sha512-not-this-one' })] } });
    const pool = fakePool();
    await startTakeOn(deps(pool, { engine: realEngine(fakeNpm(tarball)) }), ['days']);
    await takeOnSettled();
    expect(existsSync(env.BUDDI_PLUGINS_FILE!) ? readPluginsFile(env.BUDDI_PLUGINS_FILE!).plugins : []).toEqual([]);
    // Nothing of the plugin ran: the fixture writes this file when it is imported.
    expect(existsSync(process.env.BUDDI_FIXTURE_MARKER!)).toBe(false);
    expect((await readTakeOn(deps(pool))).plugins[0]).toMatchObject({ state: 'failed' });
  });
});

