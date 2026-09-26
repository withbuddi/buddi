/**
 * Settings → Notifications: the three Telegram routes the page adds to the
 * two first run uses — which bot, which phones, and letting one go.
 *
 * The unpair sits behind the session, Origin
 * and CSRF gate like every other write.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, type CoreToolContext } from '@buddi/core';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName } from './http.js';
import { telegramBot, type TelegramControl } from './telegram.js';
import { loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';

const TOKEN = '8012345678:AAHfakeTokenForTestsOnly-1234567890';
const PHONE = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const BROWSER = '2c5f39cb-3fb2-11d2-883f-0016d3cca427';

const servers: WebServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Telegram phone and one device of another surface, and the delete core runs. */
function fakePool() {
  const rows = [
    { id: PHONE, owner_id: 'owner', surface: 'telegram', external_user_id: '4242', external_chat_id: '4242', label: 'Amen', paired_at: new Date('2026-09-20T10:00:00Z'), last_seen_at: new Date('2026-09-25T08:00:00Z'), paired_via: 'code' },
    { id: BROWSER, owner_id: 'owner', surface: 'extension', external_user_id: 'x', external_chat_id: null, label: null, paired_at: new Date('2026-09-21T10:00:00Z'), last_seen_at: null, paired_via: 'code' },
  ];
  return {
    rows,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/delete from core\.surface_identities/.test(sql)) {
        const at = rows.findIndex((row) => row.id === params[0]);
        return { rows: at < 0 ? [] : rows.splice(at, 1) };
      }
      if (/from core\.surface_identities/.test(sql)) return { rows: [...rows] };
      return { rows: [] };
    }),
  };
}

async function boot(over: { env?: Record<string, string>; telegram?: TelegramControl } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'buddi-tg-'));
  dirs.push(root);
  const dir = path.join(root, 'agents');
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, BUDDI_AGENTS_DIR: dir, BUDDI_SKILLS_DIR: path.join(root, 'skills'), BUDDI_VAULT: 'memory', ...over.env };
  const pool = fakePool();
  const app = await startWebServer({
    pool: pool as never,
    registry: new ToolRegistry(),
    catalog: reloadableCatalog(() => loadGatewayCatalog({ dir, env })),
    ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC',
    now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    token: 'fixture',
    env,
    ...(over.telegram ? { telegram: over.telegram } : {}),
  });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const session = await fetch(`${origin}/api/session`);
  const cookies = session.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith(`${csrfCookieName(app.port)}=`))!.slice(`${csrfCookieName(app.port)}=`.length);
  return { origin, pool, headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf } };
}

it('names the running bot, and says there is none before a token', async () => {
  const running = await boot({ env: { TELEGRAM_BOT_TOKEN: TOKEN }, telegram: { running: () => true, botUsername: () => 'smoke_bot' } });
  expect(await (await fetch(`${running.origin}/api/telegram/bot`, { headers: running.headers })).json()).toEqual({ configured: true, running: true, username: 'smoke_bot' });

  const none = await boot({ env: { TELEGRAM_BOT_TOKEN: '' } });
  expect(await (await fetch(`${none.origin}/api/telegram/bot`, { headers: none.headers })).json()).toEqual({ configured: false, running: false, username: null });
});

it('asks Telegram for the name when no surface is up, and leaves it out when Telegram is silent', async () => {
  const answering = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'b', username: 'asked_bot' } }) }));
  expect(await telegramBot({ pool: fakePool() as never, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch: answering as never })).toEqual({ configured: true, running: false, username: 'asked_bot' });
  const down = vi.fn(async () => { throw new Error('offline'); });
  expect(await telegramBot({ pool: fakePool() as never, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch: down as never })).toEqual({ configured: true, running: false, username: null });
});

it('lists the paired Telegram phones and nothing of other surfaces', async () => {
  const { origin, headers } = await boot();
  const res = await fetch(`${origin}/api/telegram/devices`, { headers });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    devices: [{ id: PHONE, name: 'Amen', userId: '4242', pairedAt: '2026-09-20T10:00:00.000Z', lastSeenAt: '2026-09-25T08:00:00.000Z' }],
  });
});

it('unpairs a phone behind the write gate, and only a Telegram one', async () => {
  const { origin, headers, pool } = await boot();
  const route = `${origin}/api/telegram/devices/${PHONE}`;
  expect((await fetch(route, { method: 'DELETE', headers: { ...headers, 'X-Buddi-CSRF': '' } })).status).toBe(403);
  expect((await fetch(route, { method: 'DELETE', headers: { ...headers, Origin: 'https://untrusted.example' } })).status).toBe(403);
  // Another surface's device is not this route's to remove.
  const other = await fetch(`${origin}/api/telegram/devices/${BROWSER}`, { method: 'DELETE', headers });
  expect(other.status).toBe(404);
  expect(pool.rows.map((row) => row.id)).toContain(BROWSER);

  expect((await fetch(route, { method: 'DELETE', headers })).status).toBe(204);
  expect(pool.rows.map((row) => row.id)).not.toContain(PHONE);
  expect((await fetch(route, { method: 'DELETE', headers })).status).toBe(404);
});
