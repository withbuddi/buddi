/**
 * The dashboard's plugin routes: what they refuse, and where the second
 * approval comes from.
 *
 * The engine is faked whole — no npm, no registry, no disk — because the
 * decisions that belong to *these* routes are the ones worth pinning down: the
 * integrity the page was shown is passed through untouched, a refusal is a 409
 * with its sentence rather than a 500, `acknowledgeDrift` reaches the engine
 * only when the caller sent it, and a purge without the plugin's own name typed
 * back never reaches the engine at all.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { afterEach, expect, it, vi } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName } from './http.js';
import type { PluginsEngine } from './plugins.js';
import type { StagedPlugin } from '../plugins/index.js';

const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const TRUST = 'the trust sentence, whatever the engine says it is';

const STAGED: StagedPlugin = {
  id: 'stage-1',
  dir: '/data/plugins/staging/stage-1',
  packageDir: '/data/plugins/staging/stage-1/package',
  createdAt: '2026-01-01T00:00:00.000Z',
  name: 'weather',
  version: '2.1.0',
  source: { kind: 'registry', name: 'weather', version: '2.1.0' },
  publisher: 'someone',
  integrity: 'sha512-AAAA',
  stagedHash: 'sha256-beef',
  declaredName: 'weather',
  scripts: [],
  dependencies: { count: 4, withScripts: ['node-gyp-thing'] },
  claims: { schema: 'weather', hosts: ['api.example.test'], text: 'It tells you the weather.', missing: false },
  state: 'staged',
};

const PLAN = {
  contribution: { name: 'weather', version: '2.1.0', tools: [] },
  drift: ['its buddi.md claims no hosts, and its manifest declares api.example.test'],
  agents: [{ id: 'sky', handle: 'sky', drift: { state: 'not-accepted', message: 'not accepted yet' } }],
};

/** Every engine function, faked. Each test overrides the one it is about. */
function fakeEngine(over: Partial<PluginsEngine> = {}): PluginsEngine {
  return {
    TRUST_SENTENCE: TRUST,
    parsePluginSpec: vi.fn((text: string) => ({ kind: 'registry', name: text, range: 'latest' })) as never,
    stagePlugin: vi.fn(async () => STAGED),
    listStaged: vi.fn(() => []),
    approveStaged: vi.fn(async () => ({ kind: 'drift', staged: STAGED, plan: PLAN })) as never,
    rejectStaged: vi.fn(() => true),
    updatePlugin: vi.fn(async () => STAGED),
    uninstallPlugin: vi.fn(async () => ({ plan: {}, outcome: { notes: [], purged: false } })) as never,
    pluginLoadReport: vi.fn(() => []),
    verifyInstalledHash: vi.fn(() => ({ name: 'weather', matches: true, message: '' })),
    ...over,
  };
}

/** Enough of a pool for the onboarding read and the owner profile. */
function fakePool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (/from core\.onboarding/.test(sql)) {
        return { rows: [{ owner_id: 'owner', state: 'pending', steps_done: [], details: {} }] };
      }
      if (/from core\.owner/.test(sql)) {
        return { rows: [{ preferred_name: null, timezone: null, language: null, about: null, display_name: null }] };
      }
      return { rows: [] };
    }),
  };
}

async function dashboard(engine: PluginsEngine, env: NodeJS.ProcessEnv = {}) {
  const app = await startWebServer({
    pool: fakePool() as never,
    registry: new ToolRegistry(),
    catalog: { list: () => [], get: () => undefined, reload: () => {} } as unknown as AgentCatalog,
    ctx: { ownerId: 'owner' } as CoreToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 }, token: 'fixture',
    env, plugins: engine,
  });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith(`${csrfCookieName(app.port)}=`))!.slice(`${csrfCookieName(app.port)}=`.length);
  return { origin, headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf } };
}

const json = (headers: Record<string, string>): Record<string, string> => ({ ...headers, 'Content-Type': 'application/json' });

/** A record file this test owns, so nothing reads the live installation's. */
async function emptyRecord(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-plugins-'));
  const file = path.join(dir, 'plugins.json');
  await writeFile(file, JSON.stringify({ version: 2, plugins: [] }), 'utf8');
  return { BUDDI_PLUGINS_FILE: file };
}

/**
 * The same, plus a data directory of this test's own.
 *
 * An upload writes bytes under `<data>/plugins/incoming`, and a test that left
 * `BUDDI_DATA_DIR` unset would write them into the checkout's own data
 * directory — the one a running installation uses.
 */
async function ownDataDir(): Promise<NodeJS.ProcessEnv> {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-plugin-data-'));
  return { ...(await emptyRecord()), BUDDI_DATA_DIR: data };
}

it('shows the trust sentence and what is staged', async () => {
  const engine = fakeEngine({ listStaged: vi.fn(() => [STAGED]) });
  const { origin, headers } = await dashboard(engine, await emptyRecord());
  const view = await fetch(`${origin}/api/plugins`, { headers });
  expect(view.status).toBe(200);
  const body = (await view.json()) as any;
  expect(body.trust).toBe(TRUST);
  expect(body.staged).toHaveLength(1);
  expect(body.staged[0].integrity).toBe('sha512-AAAA');
  // What the approval re-checks travels with the card that is approved.
  expect(body.staged[0].stagedHash).toBe('sha256-beef');
  // And nothing that is a path on this disk does.
  expect(body.staged[0].dir).toBeUndefined();
  expect(body.staged[0].packageDir).toBeUndefined();
  expect(body.staged[0].dependencies.withScripts).toEqual(['node-gyp-thing']);
  // A checkout has no supervisor, so the page offers a command, not a button.
  expect(body.checkout).toBe(true);
});

it('passes the integrity back and answers with the plan when the drift has not been read', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const approveStaged = vi.fn(async (_id: string, opts: Record<string, unknown>) => {
    seen.push(opts);
    return { kind: 'drift' as const, staged: STAGED, plan: PLAN };
  });
  const { origin, headers } = await dashboard(fakeEngine({ approveStaged: approveStaged as never }), await emptyRecord());
  const first = await fetch(`${origin}/api/plugins/staged/stage-1/approve`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ integrity: 'sha512-AAAA' }),
  });
  expect(first.status).toBe(200);
  const body = (await first.json()) as any;
  expect(body.plan.drift).toHaveLength(1);
  expect(body.installed).toBeUndefined();
  // The first approval never acknowledges drift it has not shown anybody.
  expect(seen[0]).toMatchObject({ integrity: 'sha512-AAAA' });
  expect(seen[0]).not.toHaveProperty('acknowledgeDrift');
});

it('installs on the second approval, which is the one that acknowledges the drift', async () => {
  const record = { name: 'weather', version: '2.1.0', source: STAGED.source, entry: '/p/index.js', installedAt: 'now', schema: 'weather' };
  const approveStaged = vi.fn(async (_id: string, opts: { acknowledgeDrift?: boolean }) =>
    opts.acknowledgeDrift
      ? { kind: 'installed' as const, record, plan: {}, restartNeeded: true as const, migrations: [] }
      : { kind: 'drift' as const, staged: STAGED, plan: PLAN },
  );
  const { origin, headers } = await dashboard(fakeEngine({ approveStaged: approveStaged as never }), await emptyRecord());
  const second = await fetch(`${origin}/api/plugins/staged/stage-1/approve`, {
    method: 'POST', headers: json(headers),
    body: JSON.stringify({ integrity: 'sha512-AAAA', acknowledgeDrift: true }),
  });
  expect(second.status).toBe(200);
  const body = (await second.json()) as any;
  expect(body.installed.name).toBe('weather');
  expect(body.restartNeeded).toBe(true);
  expect(approveStaged).toHaveBeenCalledWith('stage-1', expect.objectContaining({ acknowledgeDrift: true }));
});

it('answers 409 with the refusal when the integrity is not the one that was shown', async () => {
  const refusal = Object.assign(new Error('that is not the package you were shown'), { name: 'InstallRefusal' });
  const approveStaged = vi.fn(async () => { throw refusal; });
  const { origin, headers } = await dashboard(fakeEngine({ approveStaged: approveStaged as never }), await emptyRecord());
  const answer = await fetch(`${origin}/api/plugins/staged/stage-1/approve`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ integrity: 'sha512-WRONG' }),
  });
  expect(answer.status).toBe(409);
  expect((await answer.json()) as any).toEqual({ error: 'that is not the package you were shown' });
});

it('stages as a job, and refuses an empty spec before the engine is asked', async () => {
  const engine = fakeEngine();
  const { origin, headers } = await dashboard(engine, await emptyRecord());
  const accepted = await fetch(`${origin}/api/plugins/stage`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ spec: 'weather@2.1.0' }),
  });
  expect(accepted.status).toBe(202);
  const { job } = (await accepted.json()) as any;
  expect(job.kind).toBe('stage');
  await vi.waitFor(async () => {
    const asked = await fetch(`${origin}/api/plugins/jobs/${job.id}`, { headers });
    expect(((await asked.json()) as any).phase).toBe('done');
  });
  const asked = await fetch(`${origin}/api/plugins/jobs/${job.id}`, { headers });
  expect(((await asked.json()) as any).stagedId).toBe('stage-1');

  const empty = await fetch(`${origin}/api/plugins/stage`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ spec: '   ' }),
  });
  expect(empty.status).toBe(400);
  expect(engine.stagePlugin).toHaveBeenCalledTimes(1);
});

it('will not drop a plugin\'s data unless its own name is typed back', async () => {
  const uninstallPlugin = vi.fn(async () => ({ plan: {}, outcome: { notes: [], purged: false } }));
  const { origin, headers } = await dashboard(fakeEngine({ uninstallPlugin: uninstallPlugin as never }), await emptyRecord());
  const wrong = await fetch(`${origin}/api/plugins/weather/uninstall`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ purge: true, confirm: 'whatever' }),
  });
  expect(wrong.status).toBe(409);
  expect(uninstallPlugin).not.toHaveBeenCalled();

  const kept = await fetch(`${origin}/api/plugins/weather/uninstall`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({}),
  });
  expect(kept.status).toBe(200);
  expect(uninstallPlugin).toHaveBeenCalledWith('weather', expect.objectContaining({ purge: false }));

  const purged = await fetch(`${origin}/api/plugins/weather/uninstall`, {
    method: 'POST', headers: json(headers), body: JSON.stringify({ purge: true, confirm: 'weather' }),
  });
  expect(purged.status).toBe(200);
  expect(uninstallPlugin).toHaveBeenLastCalledWith('weather', expect.objectContaining({ purge: true }));
});

/**
 * A record nobody can read is not "nothing installed".
 *
 * Everything the owner installed is still on disk and still granted to their
 * agents; a page drawing an empty list would be stating the opposite. The
 * sentence comes back as `unavailable` and the page shows that instead.
 */
it('says the record could not be read rather than drawing an empty list', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-plugins-'));
  const file = path.join(dir, 'plugins.json');
  await writeFile(file, '{ this is not json', 'utf8');
  const { origin, headers } = await dashboard(fakeEngine(), { BUDDI_PLUGINS_FILE: file });
  const view = await fetch(`${origin}/api/plugins`, { headers });
  expect(view.status).toBe(200);
  const body = (await view.json()) as any;
  expect(body.unavailable).toMatch(/could not be read/);
  expect(body.installed).toEqual([]);
});

/**
 * A restart loads what is installed and not imported yet. A plugin that threw
 * on import is not that: restarting it will throw again, and a banner that
 * never goes away is a banner nobody reads.
 */
it('does not ask for a restart for a plugin that will not load', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-plugins-'));
  const file = path.join(dir, 'plugins.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      plugins: [
        {
          name: 'weather',
          version: '2.1.0',
          entry: '/p/weather/index.js',
          schema: 'weather',
          installedAt: '2026-01-01T00:00:00.000Z',
          source: { kind: 'registry', name: 'weather', version: '2.1.0' },
        },
      ],
    }),
    'utf8',
  );
  const engine = fakeEngine({
    pluginLoadReport: vi.fn(() => [{ name: 'weather', version: '2.1.0', error: 'importing it threw: nope' }]),
  });
  const { origin, headers } = await dashboard(engine, { BUDDI_PLUGINS_FILE: file });
  const body = (await (await fetch(`${origin}/api/plugins`, { headers })).json()) as any;
  expect(body.restartNeeded).toBe(false);
  expect(body.installed[0].loaded).toBe(false);
  expect(body.installed[0].error).toMatch(/importing it threw/);
});

/**
 * What this build ships, beside what the owner installed.
 *
 * The page draws one list of capabilities, so the built-in plugins are on the
 * wire too — with no source and no version to update, because they are the
 * program. The families that *are* the program (platform, the owner's
 * first-run tools, the clock) are not plugins anybody installed and are not
 * offered as though they were.
 */
it('lists the plugins compiled into this gateway', async () => {
  const { origin, headers } = await dashboard(fakeEngine(), await emptyRecord());
  const body = (await (await fetch(`${origin}/api/plugins`, { headers })).json()) as any;
  const names = body.builtIn.map((p: { name: string }) => p.name);
  expect(names).toEqual(expect.arrayContaining(['artifacts', 'browser', 'email', 'host', 'memory', 'web']));
  // Finance is no longer one of them: it is installed like any other plugin.
  expect(names).not.toContain('finance');
  for (const internal of ['platform', 'owner', 'canvas', 'system', 'agent', 'reminder', 'schedule']) {
    expect(names, `${internal} is buddi itself, not a plugin`).not.toContain(internal);
  }
  const web = body.builtIn.find((p: { name: string }) => p.name === 'web');
  expect(typeof web.version).toBe('string');
  expect(web.contribution.tools).toBeGreaterThan(0);
  expect(Object.keys(web.contribution).sort()).toEqual(['agents', 'sentinels', 'tools', 'views']);
  // The description is the manifest's own line, and absent when it has none.
  for (const plugin of body.builtIn) {
    if (plugin.description !== undefined) expect(typeof plugin.description).toBe('string');
  }
});

/**
 * A tarball the owner has on their own machine.
 *
 * The bytes are written under the data directory and then staged exactly like
 * a `.tgz` path they could have typed, which is the property worth pinning
 * down: nothing about the upload reaches the engine except a path buddi chose,
 * and the name the file had travels beside it as a label.
 */
it('takes a tarball upload, stages it, and does not keep the file', async () => {
  const seen: Array<[unknown, Record<string, unknown>]> = [];
  const stagePlugin = vi.fn(async (spec: unknown, opts: Record<string, unknown>) => {
    seen.push([spec, opts]);
    return { ...STAGED, uploadedName: opts.uploadedName as string };
  });
  const env = await ownDataDir();
  const { origin, headers } = await dashboard(fakeEngine({ stagePlugin: stagePlugin as never }), env);
  const accepted = await fetch(`${origin}/api/plugins/upload`, {
    method: 'POST',
    headers: { ...headers, 'X-Filename': 'buddi-plugin-weather-2.1.0.tgz', 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]),
  });
  expect(accepted.status).toBe(202);
  const { job } = (await accepted.json()) as any;
  await vi.waitFor(async () => {
    const asked = await fetch(`${origin}/api/plugins/jobs/${job.id}`, { headers });
    expect(((await asked.json()) as any).phase).toBe('done');
  });

  const [spec, opts] = seen[0]!;
  expect((spec as { kind: string }).kind).toBe('tarball');
  const written = (spec as { path: string }).path;
  expect(path.dirname(written)).toBe(path.join(env.BUDDI_DATA_DIR as string, 'plugins', 'incoming'));
  // The browser's name is inside the filename, never the whole of it.
  expect(path.basename(written)).toMatch(/^[0-9a-f]{16}-buddi-plugin-weather-2\.1\.0\.tgz$/);
  expect(opts.uploadedName).toBe('buddi-plugin-weather-2.1.0.tgz');
  // Staging copied it, so the upload is gone.
  await vi.waitFor(() => expect(existsSync(written)).toBe(false));
  expect(await readdir(path.dirname(written))).toEqual([]);
});

it('keeps the uploaded filename on the staged card, which no path does', async () => {
  const uploaded: StagedPlugin = {
    ...STAGED,
    source: { kind: 'tarball', path: '/data/plugins/incoming/abc-weather.tgz' },
    uploadedName: 'weather.tgz',
  };
  const { origin, headers } = await dashboard(fakeEngine({ listStaged: vi.fn(() => [uploaded]) }), await emptyRecord());
  const body = (await (await fetch(`${origin}/api/plugins`, { headers })).json()) as any;
  expect(body.staged[0].uploadedName).toBe('weather.tgz');
  expect(body.staged[0].dir).toBeUndefined();
});

it('refuses an upload that is not a .tgz before anything is written', async () => {
  const engine = fakeEngine();
  const env = await ownDataDir();
  const { origin, headers } = await dashboard(engine, env);
  for (const name of ['weather.zip', '../escape.tgz/x', '']) {
    const refused = await fetch(`${origin}/api/plugins/upload`, {
      method: 'POST',
      headers: { ...headers, ...(name === '' ? {} : { 'X-Filename': name }) },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(refused.status, name).toBe(400);
  }
  expect(engine.stagePlugin).not.toHaveBeenCalled();
  expect(existsSync(path.join(env.BUDDI_DATA_DIR as string, 'plugins', 'incoming'))).toBe(false);
});

/**
 * The Accept button's route, as a route: behind the same gate as every other
 * write, and reaching the same 404 an unknown proposal gets anywhere else.
 * What it does once it is reached is `plugin-agents.web.test.ts`.
 */
it('gates accepting a proposed agent on the session and the CSRF token', async () => {
  const { origin, headers } = await dashboard(fakeEngine(), await emptyRecord());
  const url = `${origin}/api/plugins/garden/agents/gardener/accept`;

  const bare = await fetch(url, { method: 'POST' });
  expect(bare.status).toBe(403);

  const noToken = await fetch(url, {
    method: 'POST',
    headers: { Cookie: headers.Cookie, Origin: headers.Origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(noToken.status).toBe(403);

  // With both, it reaches the route — and this server has no garden plugin.
  const reached = await fetch(url, { method: 'POST', headers: json(headers), body: '{}' });
  expect(reached.status).toBe(404);
  expect(((await reached.json()) as { error: string }).error).toContain('gardener');
});
