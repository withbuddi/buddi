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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, type ToolContext } from '@buddi/core';
import { startWebServer, type WebServer } from './server.js';
import { probeOllama, OLLAMA_DOWNLOAD_URL } from './onboarding.js';
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
  expect(probe).toEqual({ running: true, models: ['llama3.2:3b', 'qwen3:4b'], downloadUrl: OLLAMA_DOWNLOAD_URL });
});

it('says it is not running rather than failing, whatever the local machine does', async () => {
  for (const transport of [
    async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); },
    async () => ({ ok: false, status: 500, statusText: '', headers: { get: () => null }, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }),
  ]) {
    expect(await probeOllama({ transport: transport as never })).toEqual({ running: false, models: [], downloadUrl: OLLAMA_DOWNLOAD_URL });
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
