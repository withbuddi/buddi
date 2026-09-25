/**
 * First run over the dashboard's API.
 *
 * Four routes, behind the same session, Origin and CSRF gate as every other
 * write, and one property that matters more than any of them: an owner who
 * finished or skipped the wizard here is never interviewed again on Telegram.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName } from './http.js';
import { createFirstAgent, firstSentence, FIRST_AGENT_TOOLS } from './onboarding.js';
import { createToolRegistry, loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';
import { resolveToolNames } from '@buddi/core';
import { shouldStartFirstRun } from '../agents/first-run.js';
import type { ProviderAccounts } from '../provider-accounts.js';
import { FIRST_AGENT_OPENING } from '../agents/opening.js';
import type { LoadAgentCatalogOptions } from '@buddi/core';

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
    details: {} as Record<string, string>,
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
        // The state the statement *writes*, not one it merely names: the
        // terminal guards mention 'pending' and 'in-progress' in their `where`.
        const writing = /values \(\$1, '([a-z-]+)'/.exec(sql)?.[1];
        if (writing === 'in-progress') {
          if (row.state !== 'pending') return { rows: [] };
          exists = true;
          row.state = 'in-progress';
          row.started_at ??= new Date();
          row.surface ??= String(params[1]);
        } else if (writing === 'done' || writing === 'skipped') {
          // Terminal, exactly as the store's `where` makes it: a finished
          // record is read back, never rewritten by the other ending.
          if (exists && row.state !== 'pending' && row.state !== 'in-progress') return { rows: [] };
          exists = true;
          row.state = writing;
          row.completed_at ??= new Date();
        } else if (/\(owner_id, details, updated_at\)/.test(sql)) {
          exists = true;
          row.details = { ...row.details, ...(JSON.parse(String(params[1])) as Record<string, string>) };
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

function accounts(list: Array<{ id: string; enabled: boolean; configured: boolean; defaultModel?: string; kind?: string }>) {
  // Assignments are remembered, because "who is bound to what" is exactly what
  // the rule about the shipped maker following the assistant is written on.
  const bindings: Array<{ agentId: string; accountId: string; model: string }> = [];
  const service = {
    bindings,
    view: vi.fn(() => ({
      vault: { kind: 'file' },
      accounts: list.map((a) => ({ defaultModel: 'claude-sonnet-4-5', kind: 'anthropic', ...a })),
      bindings: [...bindings],
    })),
    assign: vi.fn(async (agentId: string, body: { accountId: string; model: string }) => {
      const existing = bindings.find((b) => b.agentId === agentId);
      if (existing) Object.assign(existing, body);
      else bindings.push({ agentId, ...body });
      // The real service reloads the catalog after an assignment, which is how
      // an agent becomes available the moment it has an account. The fixture
      // does the same or the roster would answer from before the binding.
      service.reloadCatalog?.();
      return { changed: ['account'], note: '' };
    }),
    /** Set by `boot`, once there is a catalog to reload. */
    reloadCatalog: undefined as undefined | (() => void),
    refresh: vi.fn(async () => {}),
    /*
     * What the catalog asks when it decides whether an agent can run. The real
     * service answers from the binding and the account's credential; this
     * answers from the binding alone, which is the half these tests are about:
     * an agent with an account is available, one without is not.
     */
    selection: (agent: { id: string; model?: string }) => {
      const binding = bindings.find((b) => b.agentId === agent.id);
      const provider = {
        kind: 'anthropic',
        model: binding?.model ?? agent.model ?? 'claude-sonnet-4-5',
        accountId: binding?.accountId ?? '',
        credential: { kind: 'api-key', env: 'FIXTURE_KEY' },
      };
      return binding
        ? { provider, availability: { ok: true } }
        : { provider, availability: { ok: false, problem: { code: 'missing-credential', message: 'Choose a provider account for this agent.' } } };
    },
  };
  return service as unknown as ProviderAccounts & {
    assign: ReturnType<typeof vi.fn>;
    bindings: Array<{ agentId: string; accountId: string; model: string }>;
  };
}

async function boot(opts: {
  pool: ReturnType<typeof fakePool>;
  agentsDir: string;
  providerAccounts?: ProviderAccounts;
  /** Give the installation an agent of the owner's own before it starts. */
  privateAgent?: boolean;
  /** Load the shipped examples too, as the gateway does. */
  shipped?: boolean;
}) {
  if (opts.privateAgent) {
    mkdirSync(path.join(opts.agentsDir, 'already'), { recursive: true });
    writeFileSync(
      path.join(opts.agentsDir, 'already', 'agent.md'),
      ['---', 'id: already', 'handle: already', 'name: Already', 'description: An agent the owner already had.', 'tools: [memory.*]', '---', '', 'You are already here.', ''].join('\n'),
      'utf8',
    );
  }
  const env = { ...process.env, BUDDI_AGENTS_DIR: opts.agentsDir, BUDDI_SKILLS_DIR: path.join(opts.agentsDir, '..', 'skills') };
  const registry = new ToolRegistry();
  // `shipped` builds the catalog the way the gateway does — the owner's
  // directory *and* the examples tree, with the held-back rule over it — which
  // is the only way to see the agents this installation ships.
  const service = opts.providerAccounts as unknown as
    | { selection?: LoadAgentCatalogOptions['providerSelection']; reloadCatalog?: () => void }
    | undefined;
  const selection = service?.selection;
  const catalog = reloadableCatalog(() =>
    opts.shipped
      ? loadGatewayCatalog({ env, ...(selection ? { providerSelection: selection } : {}) })
      : loadGatewayCatalog({ dir: opts.agentsDir, env }),
  );
  const app = await startWebServer({
    pool: opts.pool as never,
    registry,
    catalog,
    ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC',
    now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    token: 'fixture',
    env,
    ...(opts.providerAccounts ? { providerAccounts: opts.providerAccounts } : {}),
  });
  if (service) service.reloadCatalog = () => catalog.reload();
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith(`${csrfCookieName(app.port)}=`))!.slice(`${csrfCookieName(app.port)}=`.length);
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
  expect(view).toEqual({ state: 'pending', stepsDone: [], details: {}, needs: { owner: true, model: true, agent: true } });
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

it('records what a step learned, and answers with it', async () => {
  const pool = fakePool();
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: accounts([]) });
  const bad = await fetch(`${origin}/api/onboarding/step`, { method: 'POST', headers, body: JSON.stringify({ step: 'model', accountId: 7 }) });
  expect(bad.status).toBe(400);
  const saved = await fetch(`${origin}/api/onboarding/step`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ step: 'model', accountId: 'the-one-they-chose' }),
  });
  expect((await json(saved)).details).toEqual({ accountId: 'the-one-they-chose' });
  // A later step adds to it rather than replacing it: which conversation the
  // assistant was met in, beside which account it thinks with.
  const met = await fetch(`${origin}/api/onboarding/step`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ step: 'hello', conversationId: 'c-1' }),
  });
  expect((await json(met)).details).toEqual({ accountId: 'the-one-they-chose', conversationId: 'c-1' });
  expect((await json(await fetch(`${origin}/api/onboarding`, { headers }))).details).toEqual({
    accountId: 'the-one-they-chose',
    conversationId: 'c-1',
  });
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

it('writes the first agent once, whatever arrives at the same time', async () => {
  const pool = fakePool();
  const dir = agentsDir();
  const { origin, headers } = await boot({ pool, agentsDir: dir, providerAccounts: accounts([]) });
  const body = (handle: string) => JSON.stringify({ name: handle, handle, description: 'One of two racing requests.' });
  const [first, second] = await Promise.all([
    fetch(`${origin}/api/onboarding/agent`, { method: 'POST', headers, body: body('ada') }),
    fetch(`${origin}/api/onboarding/agent`, { method: 'POST', headers, body: body('bea') }),
  ]);
  const statuses = [first!.status, second!.status].sort();
  expect(statuses).toEqual([200, 409]);
  const listed = await json(await fetch(`${origin}/api/agents`, { headers }));
  expect(listed.agents.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
  // And afterwards the route is closed: a second agent is the maker's job.
  const later = await fetch(`${origin}/api/onboarding/agent`, { method: 'POST', headers, body: body('cyd') });
  expect(later.status).toBe(409);
  expect((await json(later)).error).toMatch(/already have an agent/);
});

it('refuses to write into the examples tree even through a symlink', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'buddi-onboarding-'));
  dirs.push(root);
  const examples = path.join(root, 'examples', 'agents');
  mkdirSync(examples, { recursive: true });
  // The owner's "private" directory is a link into the platform's own tree, so
  // the two paths only look unrelated.
  const linked = path.join(root, 'agents');
  symlinkSync(examples, linked, 'dir');
  const deps = {
    pool: fakePool() as never,
    catalog: { list: () => [] } as unknown as AgentCatalog,
    agentsDir: linked,
    examplesDir: examples,
    reload: () => {},
  };
  await expect(
    createFirstAgent(deps, { name: 'Ada', handle: 'ada', description: 'Would land in examples.' }),
  ).rejects.toThrow(/examples/);
  expect(existsSync(path.join(examples, 'ada'))).toBe(false);
});

it('refuses to call setup finished while it still needs a model or an agent', async () => {
  const pool = fakePool();
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: accounts([]) });
  const refused = await fetch(`${origin}/api/onboarding/complete`, { method: 'POST', headers, body: '{}' });
  expect(refused.status).toBe(409);
  expect((await json(refused)).error).toMatch(/a model account and an agent of your own/);
  expect(pool.row.state).toBe('pending');
  // Skipping is the bypass, and it always works.
  const skipped = await fetch(`${origin}/api/onboarding/skip`, { method: 'POST', headers, body: '{}' });
  expect(skipped.status).toBe(200);
  expect((await json(skipped)).state).toBe('skipped');
});

it('closes the record so the Telegram interview never opens', async () => {
  for (const action of ['complete', 'skip'] as const) {
    const pool = fakePool();
    const { origin, headers } = await boot({
      pool,
      agentsDir: agentsDir(),
      // Nothing is missing, so `complete` is allowed to mean finished.
      providerAccounts: accounts([{ id: 'one', enabled: true, configured: true }]),
      privateAgent: true,
    });
    expect(await shouldStartFirstRun(pool as never, 'telegram')).toBe(true);
    pool.row.state = 'pending';
    pool.row.started_at = null;
    const res = await fetch(`${origin}/api/onboarding/${action}`, { method: 'POST', headers, body: '{}' });
    expect(res.status).toBe(200);
    expect((await json(res)).state).toBe(action === 'complete' ? 'done' : 'skipped');
    expect(await shouldStartFirstRun(pool as never, 'telegram')).toBe(false);
  }
});

it('keeps a finished record finished when the other ending arrives late', async () => {
  const pool = fakePool();
  const { origin, headers } = await boot({
    pool,
    agentsDir: agentsDir(),
    providerAccounts: accounts([{ id: 'one', enabled: true, configured: true }]),
    privateAgent: true,
  });
  expect((await json(await fetch(`${origin}/api/onboarding/complete`, { method: 'POST', headers, body: '{}' }))).state).toBe('done');
  const late = await fetch(`${origin}/api/onboarding/skip`, { method: 'POST', headers, body: '{}' });
  expect(late.status).toBe(200);
  expect((await json(late)).state).toBe('done');
});

/**
 * The shipped Concierge is not a colleague, it is the assistant waiting to be
 * given a name. So the first agent is written *as* it: same id, the owner's
 * handle, name, face and words, and one assistant on the roster afterwards.
 */
it('rewrites the shipped Concierge into the owner’s assistant instead of standing one next to it', async () => {
  const dir = agentsDir();
  const shipped = {
    id: 'concierge',
    handle: 'buddi',
    name: 'Concierge',
    description: 'The agent buddi ships with.',
    source: 'example' as const,
  };
  const service = accounts([
    { id: 'one', enabled: true, configured: true },
    { id: 'two', enabled: true, configured: true },
  ]);
  const pool = fakePool();
  const created = await createFirstAgent(
    {
      pool: pool as never,
      catalog: {
        list: () => [shipped],
        get: (id: string) => (id === 'concierge' ? shipped : undefined),
        byHandle: (handle: string) => (handle === 'buddi' ? shipped : undefined),
      } as unknown as AgentCatalog,
      providerAccounts: service,
      agentsDir: dir,
      examplesDir: path.join(dir, '..', 'examples'),
      reload: () => {},
    },
    { name: 'Ada', handle: 'ada', description: 'Whatever I ask.', avatar: '📚', accountId: 'two' },
  );
  // The id is the example's — that is what makes this a rename rather than a
  // second agent — and the handle is the owner's.
  expect(created.id).toBe('concierge');
  expect(created.handle).toBe('ada');
  const file = readFileSync(path.join(dir, 'concierge', 'agent.md'), 'utf8');
  expect(file).toContain('id: concierge');
  expect(file).toContain('handle: ada');
  expect(file).toContain('name: Ada');
  expect(file).toContain('avatar: 📚');
  // Being the default is recorded for the installation, not written into the
  // persona: the file the wizard leaves behind claims nothing about it.
  expect(file).not.toContain('default: true');
  const recorded = pool.query.mock.calls.find(
    ([sql]) => /core\.web_settings/.test(String(sql)) && /insert/.test(String(sql)),
  );
  expect(recorded?.[1]).toEqual(['agents', JSON.stringify({ defaultAgent: 'concierge' })]);
  expect(file).not.toContain('Concierge');
  // Bound to the account the wizard named, not to whichever one came first.
  expect(created.assigned).toBe('two');
  expect(service.assign).toHaveBeenCalledWith('concierge', { accountId: 'two', model: 'claude-sonnet-4-5' });
});

it('writes the persona as the body, and a plain card line rather than its first sentence', async () => {
  const dir = agentsDir();
  const shipped = { id: 'concierge', handle: 'buddi', name: 'Concierge', description: 'The agent buddi ships with.', source: 'example' as const };
  const persona = [
    "You're not a chatbot. You're becoming someone this person can count on.",
    '',
    'Some starting truths:',
    '',
    '- Help for real. Do the thing, then say what you did.',
  ].join('\n');
  await createFirstAgent(
    {
      pool: fakePool() as never,
      catalog: {
        list: () => [shipped],
        get: (id: string) => (id === 'concierge' ? shipped : undefined),
        byHandle: (handle: string) => (handle === 'buddi' ? shipped : undefined),
      } as unknown as AgentCatalog,
      providerAccounts: accounts([{ id: 'one', enabled: true, configured: true }]),
      agentsDir: dir,
      examplesDir: path.join(dir, '..', 'examples'),
      reload: () => {},
    },
    { name: 'Ada', handle: 'ada', description: '', instructions: persona, accountId: 'one' },
  );
  const file = readFileSync(path.join(dir, 'concierge', 'agent.md'), 'utf8');
  expect(file).toMatch(/description: .?Your first assistant\. Ask it anything; it remembers\..?\n/);
  expect(file).not.toMatch(/description: .?You're not a chatbot/);
  expect(file).toContain(`You are Ada. There is exactly one owner`);
  expect(file).toContain(persona);
  expect(file).not.toContain("What you are for, in the owner's own words");
  expect(firstSentence('  - Hello there! More.')).toBe('Hello there!');
});

it('lets the owner keep the shipped handle, and refuses one another agent holds', async () => {
  const dir = agentsDir();
  const shipped = { id: 'concierge', handle: 'buddi', name: 'Concierge', description: 'Ships with buddi.', source: 'example' as const };
  const father = { id: 'agent-father', handle: 'father', name: 'Agent Father', description: 'Makes agents.', source: 'example' as const };
  const deps = {
    pool: fakePool() as never,
    // `list()` holds Agent Father back on a fresh install; `byHandle` still
    // answers for it, which is what stops the owner claiming @father.
    catalog: {
      list: () => [shipped],
      get: (id: string) => [shipped, father].find((a) => a.id === id),
      byHandle: (handle: string) => [shipped, father].find((a) => a.handle === handle),
    } as unknown as AgentCatalog,
    agentsDir: dir,
    examplesDir: path.join(dir, '..', 'examples'),
    reload: () => {},
  };
  await expect(
    createFirstAgent(deps, { name: 'Father', handle: 'father', description: 'Not this one.' }),
  ).rejects.toThrow(/already Agent Father/);
  // The handle the example itself holds is free: the file replaces it.
  const kept = await createFirstAgent(deps, { name: 'Buddi', handle: 'buddi', description: 'Keeping the name it came with.' });
  expect(kept).toMatchObject({ id: 'concierge', handle: 'buddi' });
});

it('refuses an account the installation cannot run on, and writes nothing', async () => {
  const dir = agentsDir();
  const deps = {
    pool: fakePool() as never,
    catalog: { list: () => [], get: () => undefined, byHandle: () => undefined } as unknown as AgentCatalog,
    providerAccounts: accounts([{ id: 'one', enabled: true, configured: false }]),
    agentsDir: dir,
    examplesDir: path.join(dir, '..', 'examples'),
    reload: () => {},
  };
  await expect(
    createFirstAgent(deps, { name: 'Ada', handle: 'ada', description: 'x', accountId: 'one' }),
  ).rejects.toThrow(/not one this installation can run on/);
  expect(existsSync(path.join(dir, 'ada'))).toBe(false);
});


/*
 * The shipped maker follows the owner's choice of AI.
 *
 * It is held back until they have an assistant, and the moment it is listed it
 * has to be able to answer: an agent that appears greyed with "needs an
 * account" is a stranger the owner has to repair before they have asked it for
 * anything, over a choice they already made a minute ago.
 */
it('gives the shipped maker the same brain as the assistant it was created with', async () => {
  const pool = fakePool();
  const service = accounts([{ id: 'one', enabled: true, configured: true }]);
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: service, shipped: true });
  const created = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Whatever I ask.', accountId: 'one' }),
  });
  expect(created.status).toBe(200);
  const assistant = (await json(created)).id as string;
  expect(service.bindings).toEqual(
    expect.arrayContaining([
      { agentId: assistant, accountId: 'one', model: 'claude-sonnet-4-5' },
      { agentId: 'agent-father', accountId: 'one', model: 'claude-sonnet-4-5' },
    ]),
  );
  // And it is on the roster now, rather than held back — and able to answer,
  // which is the whole point of giving it the brain.
  const listed = await json(await fetch(`${origin}/api/agents`, { headers }));
  const maker = listed.agents.find((agent: { id: string }) => agent.id === 'agent-father');
  expect(maker, 'the maker is listed once the owner has an assistant').toBeTruthy();
  expect(listed.engines.find((engine: { id: string }) => engine.id === 'agent-father')?.available).toBe(true);
});

it('moves the maker with the assistant when the brain changes, unless it has one of its own', async () => {
  const pool = fakePool();
  const service = accounts([
    { id: 'one', enabled: true, configured: true },
    { id: 'two', enabled: true, configured: true },
    { id: 'mine', enabled: true, configured: true },
  ]);
  const { origin, headers } = await boot({ pool, agentsDir: agentsDir(), providerAccounts: service, shipped: true });
  await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Whatever I ask.', accountId: 'one' }),
  });
  const changed = await fetch(`${origin}/api/onboarding/brain`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accountId: 'two', model: 'gpt-5' }),
  });
  expect(changed.status).toBe(200);
  expect(await json(changed)).toEqual({ assistant: expect.any(String), followed: ['agent-father'] });
  expect(service.bindings.find((b) => b.agentId === 'agent-father')).toEqual({ agentId: 'agent-father', accountId: 'two', model: 'gpt-5' });

  // The owner gave the maker an account of its own on the Agents page. The
  // next change to the assistant's brain leaves that alone.
  await service.assign('agent-father', { accountId: 'mine', model: 'claude-sonnet-4-5' });
  const again = await fetch(`${origin}/api/onboarding/brain`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accountId: 'one', model: 'claude-sonnet-4-5' }),
  });
  expect((await json(again)).followed).toEqual([]);
  expect(service.bindings.find((b) => b.agentId === 'agent-father')?.accountId).toBe('mine');
});

/*
 * What the first assistant may do, and what it may not.
 *
 * `owner.*` also carries the tools the *interview* is conducted with — rename
 * yourself, finish onboarding — and an assistant holding them opened its first
 * message by offering to rename itself to an owner who had named it a minute
 * earlier.
 */
it('grants the first agent no tool for running a first run', async () => {
  const pool = fakePool();
  const dir = agentsDir();
  const { origin, headers } = await boot({ pool, agentsDir: dir, providerAccounts: accounts([{ id: 'one', enabled: true, configured: true }]) });
  const created = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Whatever I ask.' }),
  });
  expect(created.status).toBe(200);
  const file = readFileSync((await json(created)).file, 'utf8');
  expect(file).toMatch(/owner\.get_profile/);
  expect(file).toMatch(/owner\.set_profile/);
  expect(file).not.toMatch(/owner\.\*/);
  expect(file).not.toMatch(/rename_me|finish_onboarding/);
});

/*
 * The first assistant is the concierge: it reaches the web, its own browser and
 * nearly everything else built in — but never the tools that write agents.
 */
it('grants the first agent the built-in families, web and browser included', async () => {
  // Every entry resolves against what this build compiles in, so no family can
  // hold the first agent back as "needs a plugin".
  const tools = resolveToolNames(FIRST_AGENT_TOOLS, createToolRegistry({}), 'concierge');
  for (const name of ['web.search', 'web.read', 'browser.status', 'browser.act', 'host.exec', 'email.send', 'agent.delegate', 'system.time']) {
    expect(tools).toContain(name);
  }
  expect(tools.filter((name) => name.startsWith('platform.')).sort()).toEqual(
    ['platform.installed_tools', 'platform.list_agents', 'platform.list_skills', 'platform.read_agent'],
  );
  expect(tools).not.toContain('owner.rename_me');
  expect(tools).not.toContain('owner.finish_onboarding');

  const pool = fakePool();
  const dir = agentsDir();
  const { origin, headers } = await boot({ pool, agentsDir: dir, providerAccounts: accounts([{ id: 'one', enabled: true, configured: true }]) });
  const created = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Whatever I ask.' }),
  });
  expect(created.status).toBe(200);
  const file = readFileSync((await json(created)).file, 'utf8');
  expect(file).toMatch(/web\.\*/);
  expect(file).toMatch(/browser\.\*/);
});

/*
 * The one agent nobody writes by hand still carries an opening — and thinks
 * only where thinking is fast.
 */
it('writes the first agent with its opening, and with reasoning off on a local account', async () => {
  const pool = fakePool();
  const dir = agentsDir();
  const { origin, headers } = await boot({
    pool,
    agentsDir: dir,
    providerAccounts: accounts([{ id: 'local', enabled: true, configured: true, kind: 'openai-compatible', defaultModel: 'gemma4:12b' }]),
  });
  const created = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Whatever I ask.', accountId: 'local' }),
  });
  expect(created.status).toBe(200);
  const file = readFileSync((await json(created)).file, 'utf8');
  expect(file).toContain(FIRST_AGENT_OPENING.intro);
  for (const starter of FIRST_AGENT_OPENING.starters) expect(file).toContain(starter);
  expect(file).toMatch(/^starters:/m);
  expect(file).toMatch(/^thinking: off$/m);
});

it('leaves thinking to the model on every other kind of account', async () => {
  const pool = fakePool();
  const dir = agentsDir();
  const { origin, headers } = await boot({
    pool,
    agentsDir: dir,
    providerAccounts: accounts([{ id: 'hosted', enabled: true, configured: true, kind: 'anthropic' }]),
  });
  const created = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Whatever I ask.', accountId: 'hosted' }),
  });
  const file = readFileSync((await json(created)).file, 'utf8');
  expect(file).toContain(FIRST_AGENT_OPENING.intro);
  // No key at all: an absent `thinking` is the model's own default, and a
  // written one would be a claim nobody made.
  expect(file).not.toMatch(/thinking:/);
});

it('turns reasoning off when a brain change moves the assistant onto a local account', async () => {
  const pool = fakePool();
  const dir = agentsDir();
  const service = accounts([
    { id: 'hosted', enabled: true, configured: true, kind: 'anthropic' },
    { id: 'local', enabled: true, configured: true, kind: 'openai-compatible', defaultModel: 'gemma4:12b' },
  ]);
  const { origin, headers } = await boot({ pool, agentsDir: dir, providerAccounts: service });
  const created = await fetch(`${origin}/api/onboarding/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ada', handle: 'ada', description: 'Whatever I ask.', accountId: 'hosted' }),
  });
  const file = (await json(created)).file as string;
  expect(readFileSync(file, 'utf8')).not.toMatch(/thinking:/);
  const changed = await fetch(`${origin}/api/onboarding/brain`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accountId: 'local', model: 'gemma4:12b' }),
  });
  expect(changed.status).toBe(200);
  expect((await json(changed)).thinking).toBe('off');
  expect(readFileSync(file, 'utf8')).toMatch(/^thinking: off$/m);
});
