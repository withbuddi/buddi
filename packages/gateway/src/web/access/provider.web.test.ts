/**
 * The provider interface itself (specs/trusted-access.md §3), with a fake
 * provider: the registry routes by arrival, a provider that is gone ends its
 * sessions, buckets never mix, the session store caps what a provider mints,
 * and a request handed over in-process (the relay's seam) is never local.
 */
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchOf, startWebServer, type WebServer } from '../server.js';
import { onThisMachine, requestScope } from '../http.js';
import { clientKey } from '../client-key.js';
import { SessionStore, PROVIDER_SESSION_MAX_MS } from '../sessions.js';
import { arrivalOf, markRequestArrival, markSocketArrival } from './arrival.js';
import { createAccessRegistry } from './registry.js';
import type { AccessProvider } from './provider.js';

const T0 = new Date('2026-10-03T12:00:00Z');

/** A device provider on the relay's arrival: a header names the account, `ok` is the only proof it takes. */
function fakeProvider(calls: string[]): AccessProvider<{ enabled: boolean; account: string }> {
  return {
    id: 'withbuddi',
    title: 'Fake relay',
    identity: 'device',
    proxy: 'elsewhere',
    arrival: 'relay',
    settingKey: 'access.fake',
    absoluteCapMs: 60_000,
    parseSetting: (raw) => ({ enabled: (raw as { enabled?: boolean } | null)?.enabled === true, account: 'acct-1' }),
    enabled: (s) => s.enabled,
    allowed: (s) => s.account,
    status: async (s) => (s.enabled ? { state: 'ready', sentence: 'Ready' } : { state: 'off', sentence: 'Off' }),
    setup: () => ({ steps: [], fields: [] }),
    matches: (req) => arrivalOf(req) === 'relay',
    identify: async (req, setting) => {
      calls.push('identify');
      if (!setting.enabled) return { ok: false, refusal: 'setting-off', sentence: 'off', kind: 'other' };
      if (req.headers['x-pass'] !== 'ok') return { ok: false, refusal: 'bad-pass', sentence: 'bad pass', kind: 'other' };
      return { ok: true, identity: { provider: 'withbuddi', subject: 'acct-1', detail: { device: 'Safari on iPhone' }, bucket: 'relay:198.51.100.1' } };
    },
    confirm: async (session, req, setting) => (req.headers['x-pass'] === 'ok' && setting.enabled && session.providerSubject === 'acct-1' ? { answer: 'keep' } : { answer: 'end' }),
    clientKey: () => 'relay:unverified',
  };
}

const request = (headers: Record<string, string>, arrival?: 'ingress' | 'relay', remote = '127.0.0.1'): IncomingMessage => {
  const req = { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage;
  if (arrival === 'relay') markRequestArrival(req, 'relay');
  if (arrival === 'ingress') markSocketArrival(req.socket, 'ingress');
  return req;
};

describe('the registry', () => {
  it('asks only the provider whose arrival the request came by', async () => {
    const calls: string[] = [];
    const access = createAccessRegistry({ providers: [fakeProvider(calls)], readSetting: async () => ({ enabled: true }) });
    expect(await access.identify(request({ 'x-pass': 'ok' }), T0)).toBeNull();
    expect(await access.identify(request({ 'x-pass': 'ok' }, 'ingress'), T0)).toBeNull();
    expect(calls).toEqual([]);
    const asked = await access.identify(request({ 'x-pass': 'ok' }, 'relay'), T0);
    expect(asked?.provider.id).toBe('withbuddi');
    expect(asked?.result).toMatchObject({ ok: true, identity: { subject: 'acct-1', bucket: 'relay:198.51.100.1' } });
    expect((await access.identify(request({ 'x-pass': 'forged' }, 'relay'), T0))?.result).toMatchObject({ ok: false, refusal: 'bad-pass' });
  });

  it('reads a setting that cannot be read as off, and ends a session whose provider is gone', async () => {
    const calls: string[] = [];
    const access = createAccessRegistry({ providers: [fakeProvider(calls)], readSetting: async () => { throw new Error('db down'); } });
    expect((await access.identify(request({ 'x-pass': 'ok' }, 'relay'), T0))?.result).toMatchObject({ ok: false, refusal: 'setting-off' });
    expect(await access.confirm({ provider: 'cloudflare-access', providerSubject: 'x' }, request({}, 'relay'), T0)).toEqual({ answer: 'end' });
  });

  it('names a bucket per arrival, never the main listener’s', () => {
    const access = createAccessRegistry({ providers: [fakeProvider([])], readSetting: async () => null });
    expect(access.bucketOf(request({}))).toBeNull();
    expect(access.bucketOf(request({}, 'relay'))).toBe('relay:unverified');
    expect(access.bucketOf(request({}, 'ingress'))).toBe('ingress:unverified');
  });
});

describe('arrival, not the socket', () => {
  it('makes ingress and relay requests remote and never this machine, whatever they say', () => {
    const bare = { host: '127.0.0.1:4317' };
    expect(requestScope(request(bare))).toBe('local');
    expect(onThisMachine(request(bare))).toBe(true);
    for (const arrival of ['ingress', 'relay'] as const) {
      expect(requestScope(request(bare, arrival))).toBe('remote');
      expect(onThisMachine(request(bare, arrival))).toBe(false);
      expect(clientKey(request(bare, arrival))).toBe(`${arrival}:unverified`);
    }
    // A relay request has no socket at all, and is still remote.
    const socketless = { headers: bare } as unknown as IncomingMessage;
    markRequestArrival(socketless, 'relay');
    expect(requestScope(socketless)).toBe('remote');
  });
});

describe('sessions a provider minted', () => {
  it('hold the provider, its subject and detail, and the shorter of the two caps', () => {
    const store = new SessionStore();
    const capped = store.create('remote', T0, { via: 'provider', provider: 'cloudflare-access', providerSubject: 'owner@example.com', absoluteCapMs: 3_600_000 });
    expect(capped).toMatchObject({ via: 'provider', provider: 'cloudflare-access', providerSubject: 'owner@example.com', scope: 'remote' });
    expect(capped.absoluteExpiresAt?.getTime()).toBe(T0.getTime() + 3_600_000);
    const asked = store.create('remote', T0, { via: 'provider', provider: 'withbuddi', providerSubject: 'acct-1', absoluteCapMs: 30 * 24 * 3_600_000 });
    expect(asked.absoluteExpiresAt?.getTime()).toBe(T0.getTime() + PROVIDER_SESSION_MAX_MS);
    // The idle rule is the remote one: 12 hours.
    expect(capped.ttlMs).toBe(12 * 3_600_000);
  });
});

describe('a request handed over in-process (the relay’s seam)', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

  it('is never the owner at the machine, even on a loopback socket with the gate open', async () => {
    const app: WebServer = await startWebServer({
      pool: { query: async () => ({ rows: [] }) } as never,
      registry: new ToolRegistry(),
      catalog: {} as AgentCatalog,
      ctx: { ownerId: 'owner' } as CoreToolContext,
      timezone: 'UTC',
      now: () => T0,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      token: 'fixture',
      env: {},
      openAccess: true,
      log: () => {},
      tailscale: { whois: async () => null, self: async () => ({ available: false, self: null }) },
    });
    servers.push(app);
    const dispatch = dispatchOf(app.server)!;
    const relay = createServer((req, res) => { markRequestArrival(req, 'relay'); dispatch(req, res); });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => resolve()));
    servers.push({ close: () => new Promise<void>((resolve) => { relay.close(() => resolve()); relay.closeAllConnections(); }) });
    const port = (relay.address() as AddressInfo).port;
    // The main listener: open, the owner at the Mac.
    expect((await fetch(`http://127.0.0.1:${app.port}/api/session`)).status).toBe(200);
    // The same request through the seam: signed out.
    expect((await fetch(`http://127.0.0.1:${port}/api/session`)).status).toBe(401);
  });
});
