/**
 * First run over the dashboard's API.
 *
 * Four routes, behind the same session, Origin and CSRF gate as every other
 * write, and one property that matters more than any of them: an owner who
 * finished or skipped the wizard here is never interviewed again on Telegram.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, type ToolContext } from '@buddi/core';
import { startWebServer, type WebServer } from './server.js';
import { loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';
import { shouldStartFirstRun } from '../agents/first-run.js';
import type { ProviderAccounts } from '../provider-accounts.js';

/** `res.json()` is `unknown`; every body here is a small object we assert on. */
const json = async (res: Response): Promise<any> => res.json();

const servers: WebServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Just enough of `core.onboarding` and `core.owner` to be the real store's
 * database. The statements are core's; the rows are ours.
 */
function fakePool(profile: { preferredName?: string | null } = {}) {
  const row = {
    owner_id: 'owner',
    state: 'pending',
    started_at: null as Date | null,
    completed_at: null as Date | null,
    surface: null as string | null,
    steps_done: [] as string[],
    nudges_sent: 0,
    last_nudge_at: null,
    unanswered: 0,
    quiet_until: null,
    updated_at: null as Date | null,
  };
  let exists = false;
  const events: Array<{ kind: string; payload: string }> = [];
  return {
    row,
    events,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/from core\.owner/.test(sql)) {
        return { rows: [{ preferred_name: profile.preferredName ?? null, timezone: null, language: null, about: null, display_name: null }] };
      }
      if (/insert into core\.events/.test(sql)) {
        events.push({ kind: String(params[0]), payload: String(params[1]) });
        return { rows: [] };
      }
      if (/select .* from core\.onboarding/s.test(sql)) return { rows: exists ? [row] : [] };
      if (/insert into core\.onboarding/.test(sql)) {
        if (/'in-progress'/.test(sql)) {
          if (row.state !== 'pending') return { rows: [] };
          exists = true;
          row.state = 'in-progress';
          row.started_at ??= new Date();
          row.surface ??= String(params[1]);
        } else if (/'done'/.test(sql)) {
          exists = true;
          row.state = 'done';
          row.completed_at ??= new Date();
        } else if (/'skipped'/.test(sql)) {
          exists = true;
          row.state = 'skipped';
          row.completed_at ??= new Date();
        } else {
          exists = true;
          const step = String(params[1]);
          if (!row.steps_done.includes(step)) row.steps_done = [...row.steps_done, step];
        }
        row.updated_at = new Date();
        return { rows: [row] };
      }
      return { rows: [] };
    }),
  };
}

function accounts(list: Array<{ id: string; enabled: boolean; configured: boolean; defaultModel?: string }>) {
  return {
    view: vi.fn(() => ({ vault: { kind: 'file' }, accounts: list.map((a) => ({ defaultModel: 'claude-sonnet-4-5', ...a })), bindings: [] })),
    assign: vi.fn(async () => ({ changed: ['account'], note: '' })),
    refresh: vi.fn(async () => {}),
  } as unknown as ProviderAccounts & { assign: ReturnType<typeof vi.fn> };
}

async function boot(opts: {
  pool: ReturnType<typeof fakePool>;
  agentsDir: string;
  providerAccounts?: ProviderAccounts;
}) {
  const env = { ...process.env, BUDDI_AGENTS_DIR: opts.agentsDir, BUDDI_SKILLS_DIR: path.join(opts.agentsDir, '..', 'skills') };
  const registry = new ToolRegistry();
  const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir: opts.agentsDir, env }));
  const app = await startWebServer({
    pool: opts.pool as never,
    registry,
    catalog,
    ctx: { ownerId: 'owner' } as ToolContext,
    timezone: 'UTC',
    now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    token: 'fixture',
    env,
    ...(opts.providerAccounts ? { providerAccounts: opts.providerAccounts } : {}),
  });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  return { app, origin, headers, catalog };
}

function agentsDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'buddi-onboarding-'));
  dirs.push(root);
  const dir = path.join(root, 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

it('answers what first run still needs, and creates nothing by being read', async () => {
  const pool = fakePool();
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: accounts([]) });
  const view = await json(await fetch(`${origin}/api/onboarding`, { headers }));
  expect(view).toEqual({ state: 'pending', stepsDone: [], needs: { owner: true, model: true, agent: true } });
  expect(pool.row.state).toBe('pending');
});

it('counts only an enabled account with a credential as a model', async () => {
  const pool = fakePool({ preferredName: 'Sam' });
  const { origin, headers } = await boot({
    pool,
    agentsDir: agentsDir(),
    providerAccounts: accounts([{ id: 'one', enabled: true, configured: false }, { id: 'two', enabled: false, configured: true }]),
  });
  const view = await json(await fetch(`${origin}/api/onboarding`, { headers }));
  expect(view.needs).toEqual({ owner: false, model: true, agent: true });
});

it('refuses every first-run write without the CSRF header or a known origin', async () => {
  const pool = fakePool();
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: accounts([]) });
  expect((await fetch(`${origin}/api/onboarding`, { headers: { 'X-Forwarded-For': '100.64.0.2' } })).status).toBe(401);
  for (const route of ['/api/onboarding/step', '/api/onboarding/complete', '/api/onboarding/skip', '/api/onboarding/agent']) {
    expect((await fetch(`${origin}${route}`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}${route}`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
  }
  expect(pool.row.state).toBe('pending');
});

it('starts the record on the first step and records only steps it knows', async () => {
  const pool = fakePool();
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: accounts([]) });
  const bad = await fetch(`${origin}/api/onboarding/step`, { method: 'POST', headers, body: JSON.stringify({ step: 'elsewhere' }) });
  expect(bad.status).toBe(400);
  const ok = await fetch(`${origin}/api/onboarding/step`, { method: 'POST', headers, body: JSON.stringify({ step: 'welcome' }) });
  expect(ok.status).toBe(200);
  expect((await json(ok)).stepsDone).toEqual(['welcome']);
  expect(pool.row.state).toBe('in-progress');
  expect(pool.row.surface).toBe('web');
});

it('writes the first agent, makes it the default, assigns the only account and serves it as /api/agents does', async () => {
  const pool = fakePool();
  const dir = agentsDir();
  const service = accounts([{ id: 'one', enabled: true, configured: true }]);
  const { origin, headers } = await boot({ pool, agentsDir: dir, providerAccounts: service });
  const created = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Keeps track of what I am reading.', avatar: '📚' }),
  });
  expect(created.status).toBe(200);
  const body = await json(created);
  expect(body.id).toBe('ada');
  expect(body.agent).toMatchObject({ id: 'ada', handle: 'ada', name: 'Ada', isDefault: true, isExample: false });
  expect(body.agent.tools).toContain('memory.remember_preference');
  const file = readFileSync(path.join(dir, 'ada', 'agent.md'), 'utf8');
  expect(file).toContain('language: mirror');
  expect(file).toContain('avatar: 📚');
  expect(file).toContain('Keeps track of what I am reading.');
  expect(file).not.toContain('roles:');
  expect(service.assign).toHaveBeenCalledWith('ada', { accountId: 'one', model: 'claude-sonnet-4-5' });
  const listed = await json(await fetch(`${origin}/api/agents`, { headers }));
  expect(listed.agents.map((a: { id: string }) => a.id)).toContain('ada');
  // And the same handle a second time is refused rather than written over.
  const again = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada again', handle: 'ada', description: 'Another one.' }),
  });
  expect(again.status).toBe(409);
});

it('refuses a handle or a name the loader would not take', async () => {
  const pool = fakePool();
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: accounts([]) });
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ name: 'Ada', handle: 'A', description: 'x' }, /2 to 20 characters/],
    [{ name: 'Ada', handle: '9lives', description: 'x' }, /starting with a letter/],
    [{ name: '', handle: 'ada', description: 'x' }, /one to 60 characters/],
    [{ name: 'Ada', handle: 'ada', description: '' }, /what this agent is for/],
    [{ name: 'Ada', handle: 'ada', description: 'x', avatar: 'face.png' }, /emoji/],
  ];
  for (const [input, message] of cases) {
    const res = await fetch(`${origin}/api/onboarding/agent`, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(message);
  }
});

it('closes the record so the Telegram interview never opens', async () => {
  for (const action of ['complete', 'skip'] as const) {
    const pool = fakePool();
    const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: accounts([]) });
    expect(await shouldStartFirstRun(pool as never, 'telegram')).toBe(true);
    pool.row.state = 'pending';
    pool.row.started_at = null;
    const res = await fetch(`${origin}/api/onboarding/${action}`, { method: 'POST', headers, body: '{}' });
    expect(res.status).toBe(200);
    expect((await json(res)).state).toBe(action === 'complete' ? 'done' : 'skipped');
    expect(await shouldStartFirstRun(pool as never, 'telegram')).toBe(false);
  }
});
