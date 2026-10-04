/**
 * Saving a sign-in the owner made on a page they held (docs/browser.md,
 * "Saving a sign-in"), at the gateway: the hand socket asks with the site and
 * the user name and never the password; the answer route takes the owner's
 * session and CSRF like every write; Save reaches the owner-secret store as the
 * owner, through core's `secrets.put`, and nothing else; a refusal never
 * carries the store's own words.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import { OWNER_AGENT_ID, ToolRegistry, type AgentCatalog, type CoreToolContext, type PluginManifest } from '@buddi/core';
import { LoginKeeper, type BrowserController, type BrowserHand, type BrowserStatus } from '@buddi/tool-browser';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName } from './http.js';
import { ownerLoginStore, secretsAct } from './secrets.js';

const TOKEN = 'fixture-browser-logins-token';
const SESSION = 'browser-session-1';
const PASSWORD = 'fixture-pass-7Qz!';
const servers: WebServer[] = [];
const sockets: WebSocket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Core's `secrets.put`, as a fake that records who called it with what. */
function secretsRegistry(refuse = false) {
  const calls: Array<{ input: Record<string, unknown>; agentId: string | undefined }> = [];
  const registry = new ToolRegistry();
  const manifest = {
    name: 'secrets', version: '1.0.0', schema: 'core', migrationsDir: '',
    tools: [{
      name: 'secrets.put', tier: 'auto', ownerOnly: true, description: 'Store one of the owner’s secrets. Owner only.',
      input: z.object({ name: z.string(), value: z.string(), bindings: z.array(z.unknown()).optional() }).strict(),
      execute: async (input: Record<string, unknown>, ctx: CoreToolContext) => {
        if (refuse) throw new Error(`the vault refused ${String(input.value)}`);
        calls.push({ input, agentId: ctx.agentId });
        return { name: input.name, found: [] };
      },
    }],
  } as unknown as PluginManifest;
  registry.register(manifest);
  return { registry, calls };
}

async function keeper(): Promise<LoginKeeper> {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-gw-logins-'));
  dirs.push(dir);
  return new LoginKeeper(path.join(dir, 'logins.json'));
}

/** A controller with one paused session, its hand, and the login keeper. */
function controller(logins: LoginKeeper): BrowserController {
  const hand: BrowserHand = { start: async () => {}, input: async () => {}, stop: vi.fn(async () => {}) };
  const status = (): BrowserStatus => ({ state: 'paused', enabled: true, busy: false, hasScreenshot: false, mode: 'playwright',
    session: { id: SESSION, agentId: 'concierge', conversationId: 'c1', requestId: 'r1', task: 'Sign in', expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: 1, maxSteps: 80 } });
  return {
    logins,
    enable: async () => {}, shutdown: async () => {}, status,
    screenshot: () => undefined, execute: async () => ({}), secretFill: async () => ({}), secretType: async () => ({}),
    control: async () => status(),
    hand: (scope) => (scope?.sessionId === SESSION ? { supported: true, hand } : { supported: true, message: 'gone' }),
  };
}

async function setup(browser: BrowserController, registry = new ToolRegistry(), openAccess = true) {
  const lines: string[] = [];
  const app = await startWebServer({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    registry, catalog: {} as AgentCatalog, ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC', now: () => new Date(), config: { enabled: true, host: '127.0.0.1', port: 0 },
    openAccess, token: TOKEN, browser, log: (line) => lines.push(line) });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${origin}/api/session`, { redirect: 'manual' });
  const pairs = res.headers.getSetCookie().map((line) => line.split(';')[0]!);
  const csrf = pairs.find((p) => p.startsWith(`${csrfCookieName(app.port)}=`))?.slice(`${csrfCookieName(app.port)}=`.length) ?? '';
  const cookie = pairs.join('; ');
  return { origin, csrf, cookie, lines,
    headers: { Cookie: cookie, 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' },
    url: `ws://127.0.0.1:${app.port}/api/browser/hand` };
}

function drive(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const raw: string[] = [];
  const seen: Array<Record<string, unknown>> = [];
  socket.on('message', (data, isBinary) => { if (!isBinary) { raw.push(String(data)); seen.push(JSON.parse(String(data)) as Record<string, unknown>); } });
  const open = new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const next = async (type: string, nth = 0): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 300; i++) {
      const frames = seen.filter((f) => f.type === type);
      if (frames[nth]) return frames[nth]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${type} frame arrived; saw ${JSON.stringify(seen)}`);
  };
  return { socket, raw, seen, open, next, send: (frame: unknown) => socket.send(JSON.stringify(frame)) };
}

describe('the hand socket asks about a sign-in', () => {
  it('says the site and the user name, never the password, and asks again after a reconnect', async () => {
    const logins = await keeper();
    const { url, headers, csrf, origin } = await setup(controller(logins));
    const hand = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await hand.open;
    hand.send({ type: 'hello', csrf, sessionId: SESSION });
    await hand.next('driving');
    // Another page's sign-in is not this socket's question.
    await logins.seen('another-session', { origin: 'https://elsewhere.test', username: 'x', password: 'other-pass' });
    const prompt = await logins.seen(SESSION, { origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD });
    expect(await hand.next('loginSeen')).toEqual({ type: 'loginSeen', id: prompt!.id, site: 'amazon.com', username: 'sam@example.com' });
    expect(hand.raw.join('\n')).not.toContain(PASSWORD);
    expect(hand.raw.join('\n')).not.toContain('other-pass');
    hand.socket.close();
    await vi.waitFor(() => expect(hand.socket.readyState).toBe(WebSocket.CLOSED));

    const again = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await again.open;
    again.send({ type: 'hello', csrf, sessionId: SESSION });
    expect(await again.next('loginSeen')).toMatchObject({ id: prompt!.id, site: 'amazon.com' });
    expect(again.raw.join('\n')).not.toContain(PASSWORD);
  });
});

describe('POST /api/browser/login', () => {
  it('takes the owner’s session and CSRF, and Save reaches the owner-secret store as the owner', async () => {
    const logins = await keeper();
    const { registry, calls } = secretsRegistry();
    const { origin, headers, lines } = await setup(controller(logins), registry);
    const prompt = await logins.seen(SESSION, { origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD });
    const body = JSON.stringify({ id: prompt!.id, decision: 'save' });

    // No CSRF token, or another origin: refused before anything is decided.
    expect((await fetch(`${origin}/api/browser/login`, { method: 'POST', headers: { Cookie: headers.Cookie, Origin: origin, 'Content-Type': 'application/json' }, body })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/login`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body })).status).toBe(403);
    expect(calls).toEqual([]);
    expect(logins.pending()).toHaveLength(1);
    expect((await fetch(`${origin}/api/browser/login`, { method: 'POST', headers, body: JSON.stringify({ id: prompt!.id, decision: 'maybe' }) })).status).toBe(400);

    const res = await fetch(`${origin}/api/browser/login`, { method: 'POST', headers, body });
    expect(res.status).toBe(200);
    const answer = await res.json() as Record<string, unknown>;
    expect(answer).toMatchObject({ outcome: 'saved', saved: { name: 'login · amazon.com', site: 'amazon.com', username: 'sam@example.com' } });
    expect(JSON.stringify(answer)).not.toContain(PASSWORD);
    expect(calls).toEqual([{ agentId: OWNER_AGENT_ID, input: { name: 'login · amazon.com', value: PASSWORD, bindings: [{ kind: 'browser.field', target: 'https://www.amazon.com', rule: 'first-time' }] } }]);
    expect(lines.join('\n')).not.toContain(PASSWORD);

    // Answered: a second answer finds nothing held.
    expect(await (await fetch(`${origin}/api/browser/login`, { method: 'POST', headers, body })).json()).toEqual({ outcome: 'gone' });
  });

  it('needs a session at all when the gate is closed', async () => {
    const logins = await keeper();
    const { origin } = await setup(controller(logins), new ToolRegistry(), false);
    const res = await fetch(`${origin}/api/browser/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'x', decision: 'save' }) });
    expect(res.status).toBe(401);
  });

  it('Never and Not now store nothing; a store that refuses says so without its own words', async () => {
    const logins = await keeper();
    const { registry, calls } = secretsRegistry(true);
    const { origin, headers, lines } = await setup(controller(logins), registry);
    const one = await logins.seen(SESSION, { origin: 'https://a.test', username: 'u', password: PASSWORD });
    expect(await (await fetch(`${origin}/api/browser/login`, { method: 'POST', headers, body: JSON.stringify({ id: one!.id, decision: 'later' }) })).json()).toEqual({ outcome: 'dismissed' });
    const two = await logins.seen(SESSION, { origin: 'https://b.test', username: 'u', password: PASSWORD });
    expect(await (await fetch(`${origin}/api/browser/login`, { method: 'POST', headers, body: JSON.stringify({ id: two!.id, decision: 'never' }) })).json()).toEqual({ outcome: 'never' });
    expect(logins.never()).toEqual(['b.test']);
    const three = await logins.seen(SESSION, { origin: 'https://c.test', username: 'u', password: PASSWORD });
    const refused = await fetch(`${origin}/api/browser/login`, { method: 'POST', headers, body: JSON.stringify({ id: three!.id, decision: 'save' }) });
    expect(refused.status).toBe(409);
    const text = await refused.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain('Keys and secrets');
    expect(calls).toEqual([]);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });
});

describe('the store and the Keys and secrets writes', () => {
  it('the login store calls only secrets.put, as the owner, and hides a refusal’s words', async () => {
    const invoke = vi.fn(async () => ({ ok: false, reason: 'failed', message: `vault said no to ${PASSWORD}` }));
    const store = ownerLoginStore({ pool: {} as never, registry: { invoke } as never, ctx: { agentId: 'concierge' } as never });
    await expect(store({ name: 'login · a.test', value: PASSWORD, bindings: [] })).rejects.toThrow('buddi could not keep that login.');
    const [tool, , ctx] = invoke.mock.calls[0]! as unknown as [string, unknown, { agentId: string }];
    expect(tool).toBe('secrets.put');
    expect(ctx.agentId).toBe(OWNER_AGENT_ID);
  });

  it('Remove on a kept login drops its label too', async () => {
    const forget = vi.fn(async () => true);
    const invoke = vi.fn(async () => ({ ok: true, output: { deleted: true } }));
    const deps = { pool: {} as never, registry: { invoke } as never, ctx: {} as never, logins: { saved: () => [], forget } };
    await secretsAct(deps as never, { tool: 'secrets.delete', args: { name: 'login · amazon.com' } }, { id: 'remove-session' });
    expect(forget).toHaveBeenCalledWith('login · amazon.com');
  });
});
