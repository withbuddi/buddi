/**
 * The two routes the first-run thread added: is Ollama there, and Telegram
 * without a terminal.
 *
 * Both are the owner acting on their own installation, so both sit behind the
 * session, Origin and CSRF gate every other write does — and the Ollama probe
 * proves one more thing: the *server* asks the local machine, because the page
 * is not allowed to reach anything but its own origin.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, type ToolContext } from '@buddi/core';
import { startWebServer, type WebServer } from './server.js';
import { OPENING_TURN_SPEAKER } from '@buddi/core';
import { claimOpeningTurn, probeOllama, updateFirstAgent, withFirstRunFacts, OLLAMA_BASE_URL, OLLAMA_DOWNLOAD_URL } from './onboarding.js';
import { readChatTranscript } from './chat.js';
import { readConversation } from './read.js';
import { saveTelegramToken, telegramPairing, TelegramWebError } from './telegram.js';
import { loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';

const json = async (res: Response): Promise<any> => res.json();

const servers: WebServer[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Enough of a pool for the pairing insert and the device list. */
function fakePool() {
  const devices: Array<{ surface: string }> = [];
  return {
    devices,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/insert into core\.pairing_codes/.test(sql)) {
        return { rows: [{ code: params[0], expires_at: new Date('2026-09-20T10:00:00Z') }] };
      }
      if (/from core\.surface_identities/.test(sql)) return { rows: [] };
      if (/from core\.owner/.test(sql)) return { rows: [{ preferred_name: null, timezone: null, language: null, about: null, display_name: null }] };
      return { rows: [] };
    }),
  };
}

function agentsDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'buddi-meet-'));
  dirs.push(root);
  const dir = path.join(root, 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function boot(over: { env?: Record<string, string> } = {}) {
  const dir = agentsDir();
  const env = { ...process.env, BUDDI_AGENTS_DIR: dir, BUDDI_SKILLS_DIR: path.join(dir, '..', 'skills'), ...over.env };
  const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir, env }));
  const app = await startWebServer({
    pool: fakePool() as never,
    registry: new ToolRegistry(),
    catalog,
    ctx: { ownerId: 'owner' } as ToolContext,
    timezone: 'UTC',
    now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    token: 'fixture',
    env,
  });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  return { origin, headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' } };
}

/* ------------------------------------------------------------------ *
 * Ollama
 * ------------------------------------------------------------------ */

it('reports the models Ollama has pulled when it answers here', async () => {
  const probe = await probeOllama({
    transport: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({ models: [{ name: 'llama3.2:3b' }, { model: 'qwen3:4b' }, { name: 42 }] }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  });
  // The address travels with the answer: the page names no host, not even
  // this one, so an account for Ollama is built from what the server says.
  expect(probe).toEqual({ running: true, models: ['llama3.2:3b', 'qwen3:4b'], downloadUrl: OLLAMA_DOWNLOAD_URL, baseUrl: `${OLLAMA_BASE_URL}/v1` });
});

it('says it is not running rather than failing, whatever the local machine does', async () => {
  for (const transport of [
    async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); },
    async () => ({ ok: false, status: 500, statusText: '', headers: { get: () => null }, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }),
  ]) {
    expect(await probeOllama({ transport: transport as never })).toEqual({ running: false, models: [], downloadUrl: OLLAMA_DOWNLOAD_URL, baseUrl: `${OLLAMA_BASE_URL}/v1` });
  }
});

it('gives up on a machine that accepts the connection and then says nothing', async () => {
  const idle = createServer(() => {
    /* Accepts, answers never. The probe is a question about this machine. */
  });
  await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => { idle.close(() => resolve()); }));
  const port = (idle.address() as { port: number }).port;
  const started = Date.now();
  expect(await probeOllama({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 200 })).toMatchObject({ running: false });
  expect(Date.now() - started).toBeLessThan(3_000);
});

it('answers the probe over the API, and never asks the page to do it', async () => {
  const { origin, headers } = await boot();
  const res = await fetch(`${origin}/api/onboarding/ollama`, { headers });
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(typeof body.running).toBe('boolean');
  expect(Array.isArray(body.models)).toBe(true);
  expect(body.downloadUrl).toBe(OLLAMA_DOWNLOAD_URL);
  expect(body.baseUrl).toBe(`${OLLAMA_BASE_URL}/v1`);
});

/* ------------------------------------------------------------------ *
 * Telegram
 * ------------------------------------------------------------------ */

const TOKEN = '8012345678:AAHfakeTokenForTestsOnly-1234567890';

it('refuses the Telegram writes without the CSRF header or a known origin', async () => {
  const { origin, headers } = await boot({ env: { BUDDI_VAULT: 'memory' } });
  for (const route of ['/api/telegram/token', '/api/telegram/pairing']) {
    expect((await fetch(`${origin}${route}`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}${route}`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
  }
});

it('refuses something that is not a bot token, in words the owner can act on', async () => {
  const { origin, headers } = await boot({ env: { BUDDI_VAULT: 'memory', TELEGRAM_BOT_TOKEN: '' } });
  const res = await fetch(`${origin}/api/telegram/token`, { method: 'POST', headers, body: JSON.stringify({ token: 'my-bot' }) });
  expect(res.status).toBe(400);
  expect((await json(res)).error).toMatch(/BotFather/);
});

it('keeps the token, starts the surface in this process, and says so', async () => {
  const vault = { kind: 'memory' as const, set: vi.fn(async () => {}), get: vi.fn(async () => null), delete: vi.fn(async () => {}), list: vi.fn(async () => []) };
  const env: NodeJS.ProcessEnv = {};
  let up = false;
  const saved = await saveTelegramToken({
    pool: fakePool() as never,
    env,
    vault: vault as never,
    telegram: { running: () => up, start: async () => { up = true; return { botUsername: 'smoke_bot' }; } },
  }, TOKEN);
  expect(vault.set).toHaveBeenCalledWith('TELEGRAM_BOT_TOKEN', TOKEN);
  expect(env.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
  expect(saved).toMatchObject({ configured: true, running: true, restartNeeded: false, botUsername: 'smoke_bot' });
});

it('keeps the token and asks for a restart when this process cannot start the surface', async () => {
  const vault = { kind: 'memory' as const, set: vi.fn(async () => {}), get: vi.fn(async () => null), delete: vi.fn(async () => {}), list: vi.fn(async () => []) };
  const env: NodeJS.ProcessEnv = {};
  const saved = await saveTelegramToken({ pool: fakePool() as never, env, vault: vault as never }, TOKEN);
  expect(saved).toMatchObject({ configured: true, running: false, restartNeeded: true });
  expect(vault.set).toHaveBeenCalled();
});

it('mints a pairing code and its link from the running bot, and refuses before there is a token', async () => {
  const pool = fakePool();
  const env: NodeJS.ProcessEnv = {};
  await expect(telegramPairing({ pool: pool as never, env })).rejects.toBeInstanceOf(TelegramWebError);
  env.TELEGRAM_BOT_TOKEN = TOKEN;
  const offer = await telegramPairing({
    pool: pool as never,
    env,
    telegram: { running: () => true, botUsername: () => 'smoke_bot' },
  });
  expect(offer.code).toMatch(/\S/);
  expect(offer.link).toBe(`https://t.me/smoke_bot?start=${offer.code}`);
});


/* ------------------------------------------------------------------ *
 * The one turn first run sends on the owner's behalf
 * ------------------------------------------------------------------ */

/** A record with `details`, and the statements core writes against it. */
function recordPool(details: Record<string, string> = {}) {
  const row = { owner_id: 'owner', state: 'pending', steps_done: [] as string[], details: { ...details } };
  const messages: Array<{ speaker: string | null }> = [];
  return {
    row,
    messages,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/from core\.onboarding/.test(sql)) return { rows: [row] };
      if (/insert into core\.onboarding/.test(sql) && /details/.test(sql)) {
        row.details = { ...row.details, ...(JSON.parse(String(params[1])) as Record<string, string>) };
        return { rows: [row] };
      }
      if (/from core\.messages/.test(sql)) {
        return { rows: messages.filter((m) => m.speaker === params[1]).map(() => ({ '?column?': 1 })) };
      }
      return { rows: [] };
    }),
  };
}

const onboardingDeps = (pool: ReturnType<typeof recordPool>) =>
  ({ pool, catalog: { list: () => [] }, agentsDir: '/nowhere', examplesDir: '/nowhere-else', reload: () => {} }) as never;

it('claims the opening turn once, and refuses a second conversation', async () => {
  const pool = recordPool();
  await claimOpeningTurn(onboardingDeps(pool), 'c1');
  expect(pool.row.details).toEqual({ conversationId: 'c1' });
  // The same conversation again is a retry — the send may never have gone out —
  // and is allowed until that conversation actually holds the turn.
  await claimOpeningTurn(onboardingDeps(pool), 'c1');
  pool.messages.push({ speaker: OPENING_TURN_SPEAKER });
  await expect(claimOpeningTurn(onboardingDeps(pool), 'c1')).rejects.toThrow(/already introduced itself/);
  // Another conversation is the reload case, and is refused outright.
  await expect(claimOpeningTurn(onboardingDeps(pool), 'c2')).rejects.toThrow(/another conversation/);
});

/**
 * Both transcript readers ask the *database* to leave the opening turn out.
 *
 * The end-to-end proof lives in the DB suites, which need Postgres; this is
 * the property that can be checked without one, and it is the one that would
 * silently regress: a reader that stops passing the speaker starts showing the
 * owner an instruction they never wrote.
 */
it('leaves the opening turn out of the chat transcript and of Activity', async () => {
  const asked: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      asked.push({ sql, params });
      if (/from core\.conversations/.test(sql)) {
        return { rows: [{ id: 'c1', agent_id: 'ada', group_id: null, created_at: new Date() }] };
      }
      return { rows: [] };
    }),
  } as never;
  await readChatTranscript(pool, '11111111-1111-1111-1111-111111111111');
  await readConversation(pool, '11111111-1111-1111-1111-111111111111');
  const reads = asked.filter((call) => /select id, role, content/.test(call.sql));
  expect(reads.length).toBe(2);
  for (const call of reads) {
    expect(call.sql).toMatch(/speaker is distinct from \$2/);
    expect(call.params[1]).toBe(OPENING_TURN_SPEAKER);
  }
});

/* ------------------------------------------------------------------ *
 * Changing the assistant that already exists
 * ------------------------------------------------------------------ */

it('changes the assistant in place: same file, same id, new name, face and purpose', async () => {
  const dir = agentsDir();
  const agentDir = path.join(dir, 'concierge');
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'agent.md');
  writeFileSync(
    file,
    ['---', 'id: concierge', 'handle: ada', 'name: Ada', 'description: Whatever I ask.', 'default: true',
      'tools: [memory.*]', 'language: mirror', 'avatar: "📚"', '---', '', 'You are Ada. Keep notes.', ''].join('\n'),
    'utf8',
  );
  const env = { ...process.env, BUDDI_AGENTS_DIR: dir, BUDDI_SKILLS_DIR: path.join(dir, '..', 'skills') };
  const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir, env }));
  const changed = updateFirstAgent(
    { pool: fakePool() as never, catalog, agentsDir: dir, examplesDir: path.join(dir, 'examples'), reload: () => catalog.reload() },
    { name: 'Noor', avatar: '🧭', description: 'Whatever I ask, and reminders.' },
  );
  expect(changed.id).toBe('concierge');
  const written = readFileSync(file, 'utf8');
  expect(written).toMatch(/name: Noor/);
  expect(written).toMatch(/description: Whatever I ask, and reminders\./);
  expect(written).toMatch(/avatar: "?🧭"?/);
  // Nothing else in the file moved, and there is still exactly one agent.
  expect(written).toMatch(/id: concierge/);
  expect(written).toMatch(/tools: \[memory\.\*\]/);
  expect(catalog.list().filter((agent) => agent.source !== 'example').length).toBe(1);
  // A persona the owner wrote themselves is not rewritten under them.
  expect(written).toMatch(/You are Ada\. Keep notes\./);
});

it('refuses to change an assistant that does not exist yet', () => {
  const dir = agentsDir();
  const env = { ...process.env, BUDDI_AGENTS_DIR: dir, BUDDI_SKILLS_DIR: path.join(dir, '..', 'skills') };
  const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir, env }));
  expect(() =>
    updateFirstAgent(
      { pool: fakePool() as never, catalog, agentsDir: dir, examplesDir: path.join(dir, 'examples'), reload: () => {} },
      { name: 'Noor' },
    ),
  ).toThrow(/no assistant of your own/i);
});

it('puts the two names it knows in front of the opening instruction', async () => {
  const dir = agentsDir();
  mkdirSync(path.join(dir, 'concierge'), { recursive: true });
  writeFileSync(
    path.join(dir, 'concierge', 'agent.md'),
    ['---', 'id: concierge', 'handle: ada', 'name: Ada', 'description: Whatever I ask.', 'default: true', 'tools: [memory.*]', '---', '', 'You are Ada.', ''].join('\n'),
    'utf8',
  );
  const env = { ...process.env, BUDDI_AGENTS_DIR: dir, BUDDI_SKILLS_DIR: path.join(dir, '..', 'skills') };
  const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir, env }));
  const named = {
    query: vi.fn(async (sql: string) =>
      /from core\.owner/.test(sql)
        ? { rows: [{ preferred_name: 'Amen', timezone: null, language: null, about: null, display_name: null }] }
        : { rows: [] },
    ),
  };
  const deps = (pool: unknown) => ({ pool, catalog, agentsDir: dir, examplesDir: path.join(dir, 'examples'), reload: () => {} }) as never;
  // The owner said their name a minute ago and named the assistant themselves;
  // a first message that asks either again is the install forgetting.
  expect(await withFirstRunFacts(deps(named), 'Introduce yourself.')).toBe('The owner is called Amen. You are Ada. Introduce yourself.');
  // And an installation that knows neither still gets the three asks, whole.
  const anonymous = { query: vi.fn(async () => ({ rows: [{ preferred_name: null, timezone: null, language: null, about: null, display_name: null }] })) };
  const empty = reloadableCatalog(() => loadGatewayCatalog({ dir: agentsDir(), env }));
  expect(
    await withFirstRunFacts({ pool: anonymous, catalog: empty, agentsDir: dir, examplesDir: dir, reload: () => {} } as never, 'Introduce yourself.'),
  ).toBe('Introduce yourself.');
});
