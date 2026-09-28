/**
 * `http.header` (docs/owner-secrets.md §3): the header inserted by the
 * area itself, after the address checks, from the host the URL names — never
 * the caller's claim; HTTPS only; a pending approval and a refusal come back
 * as typed failures; the destination is registered under core's own name and
 * refuses every other plugin.
 */
import { describe, expect, it } from 'vitest';
import { registerSecretDestination, resetSecretDestinations, secretDestination } from '../secrets/destinations.js';
import { useOwnerSecret } from '../secrets/use.js';
import type { Vault } from '../vault/types.js';
import { createMemoryVault } from '../vault/memory.js';
import type { Pool } from 'pg';
import {
  HTTP_HEADER_KIND,
  HTTP_HEADER_PLUGIN,
  HTTP_URL_KIND,
  isOwnUrlBinding,
  registerHttpUrlDestination,
  SecretPendingError,
  createHttpArea,
  registerHttpHeaderDestination,
  type HttpHeaderTarget,
} from './http.js';

/** A transport that records what it was handed and answers a canned status. */
function recordingTransport(calls: Array<{ url: string; headers: Record<string, string> }>) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

const area = (opts: {
  calls: Array<{ url: string; headers: Record<string, string> }>;
  deliver?: (name: string, host: string, header: string) => Promise<{ ok: true; value: string } | { pending: string } | { refused: string }>;
}) =>
  createHttpArea({
    plugin: 'webhooks',
    network: ['api.example.test'],
    log: () => {},
    transport: (() => recordingTransport(opts.calls)) as never,
    ...(opts.deliver !== undefined
      ? { secrets: { deliverFor: opts.deliver } }
      : {}),
  });

describe('the auth param', () => {
  it('inserts the secret under the default header, on the host the URL names', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const taken: Array<{ name: string; host: string; header: string }> = [];
    const a = area({
      calls,
      deliver: async (name, host, header) => {
        taken.push({ name, host, header });
        return { ok: true, value: 'the-value' };
      },
    });
    const res = await a.request({ url: 'https://api.example.test/v1/things', auth: { secret: 'API token' } });
    expect(res.status).toBe(200);
    expect(taken).toEqual([{ name: 'API token', host: 'api.example.test', header: 'Authorization' }]);
    expect(calls[0]?.headers).toEqual({ Authorization: 'the-value' });
  });

  it('honours a named header and keeps the headers the caller set', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const a = area({ calls, deliver: async () => ({ ok: true, value: 'v' }) });
    await a.request({
      url: 'https://api.example.test/v1',
      headers: { 'X-Trace': 'trace-1' },
      auth: { secret: 'API token', header: 'X-Api-Key' },
    });
    expect(calls[0]?.headers).toEqual({ 'X-Trace': 'trace-1', 'X-Api-Key': 'v' });
  });

  it('refuses plain HTTP before asking for any value', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let asked = 0;
    const a = area({
      calls,
      deliver: async () => {
        asked++;
        return { ok: true, value: 'v' };
      },
    });
    await expect(a.request({ url: 'http://api.example.test/v1', auth: { secret: 'API token' } })).rejects.toThrow(
      /HTTPS/,
    );
    expect(asked).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a pending approval is a typed error naming the action', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const a = area({ calls, deliver: async () => ({ pending: 'action-1' }) });
    const err = await a.request({ url: 'https://api.example.test/', auth: { secret: 'S' } }).catch((e) => e);
    expect(err).toBeInstanceOf(SecretPendingError);
    expect((err as SecretPendingError).actionId).toBe('action-1');
    expect(calls).toEqual([]);
  });

  it('a refusal is the refusal, without any value', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const a = area({ calls, deliver: async () => ({ refused: '"S" is not bound to the Authorization header of requests to api.example.test.' }) });
    await expect(a.request({ url: 'https://api.example.test/', auth: { secret: 'S' } })).rejects.toThrow(
      /not bound/,
    );
    expect(calls).toEqual([]);
  });

  it('a request with no auth is untouched, and a process without secrets says so', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const a = area({ calls });
    await a.request({ url: 'https://api.example.test/', headers: { Accept: 'application/json' } });
    expect(calls[0]?.headers).toEqual({ Accept: 'application/json' });
    const bare = createHttpArea({
      plugin: 'webhooks',
      network: ['api.example.test'],
      log: () => {},
      transport: (() => recordingTransport([])) as never,
    });
    await expect(bare.request({ url: 'https://api.example.test/', auth: { secret: 'S' } })).rejects.toThrow(
      /cannot deliver a secret/,
    );
  });
});

describe('the http.header destination', () => {
  it('is registered under core’s own name, and describes a target in its own words', () => {
    registerHttpHeaderDestination();
    const destination = secretDestination(HTTP_HEADER_KIND);
    expect(destination?.plugin).toBe(HTTP_HEADER_PLUGIN);
    expect(destination?.maxRule).toBe('pre-approved');
    expect(destination?.describe({ host: 'api.example.test', header: 'Authorization' })).toBe(
      'the Authorization header of requests to api.example.test',
    );
  });

  it('checks the host and the header, case-insensitively on the header', () => {
    registerHttpHeaderDestination();
    const destination = secretDestination(HTTP_HEADER_KIND)!;
    const bound: HttpHeaderTarget = { host: 'api.example.test', header: 'Authorization' };
    expect(destination.checkTarget({ host: 'api.example.test', header: 'authorization' }, bound, {} as never)).toBe(true);
    expect(destination.checkTarget({ host: 'api.example.test', header: 'X-Api-Key' }, bound, {} as never)).toBe(false);
    expect(destination.checkTarget({ host: 'evil.example.test', header: 'Authorization' }, bound, {} as never)).toBe(false);
    expect(destination.checkTarget('https://api.example.test', bound, {} as never)).toBe(false);
  });

  it('re-registering from core replaces, and another plugin may not take the name', () => {
    registerHttpHeaderDestination();
    registerHttpHeaderDestination();
    expect(() =>
      registerSecretDestination('mail', {
        kind: HTTP_HEADER_KIND,
        maxRule: 'pre-approved',
        checkTarget: () => true,
        describe: () => '',
        deliver: () => {},
      }),
    ).toThrow(/only as mail\.<what>/);
    resetSecretDestinations();
  });

  it('a use of the kind by a plugin is refused, and core’s internal delivery is an ordinary use', async () => {
    registerHttpHeaderDestination();
    const vault: Vault = createMemoryVault({ seed: {} });
    const pool = {
      async query(sql: string) {
        if (sql.includes('insert into core.secret_uses')) return { rows: [{ id: 'use-1' }] };
        return { rows: [] as unknown[] };
      },
    } as unknown as Pool;
    // A plugin naming core's kind is refused by plugin, before anything else.
    const result = await useOwnerSecret(
      { pool, vault, plugin: 'mail', buddi: {} as never, now: () => new Date() },
      { name: 'Whatever', kind: HTTP_HEADER_KIND, target: { host: 'api.example.test', header: 'Authorization' } },
    );
    expect(result).toEqual({ refused: "http.header is http's destination, not mail's." });
    resetSecretDestinations();
  });
});

/*
 * `as: 'url'` (host API 1.9, `http.url`): the secret is the whole address, a
 * calendar's private ICS link. The caller names only the host; core fetches
 * the stored address once it is HTTPS on that same host and passes the
 * address rules. GET only; the value never reaches the caller.
 */
describe('a secret that is the whole address', () => {
  type Delivery = { ok: true; value: string } | { pending: string } | { refused: string };
  const urlArea = (calls: Array<{ url: string; headers: Record<string, string> }>, deliver: (name: string, host: string) => Promise<Delivery>, transport?: unknown) =>
    createHttpArea({
      plugin: 'calendar',
      network: ['calendar.example.test'],
      log: () => {},
      transport: (transport ?? (() => recordingTransport(calls))) as never,
      secrets: { deliverFor: async () => ({ refused: 'no headers here' }), deliverUrlFor: deliver },
    });
  const LINK = 'https://calendar.example.test/ical/me/private-0123456789abcdef/basic.ics';

  it('fetches the stored address, asked for by host only', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const asked: Array<{ name: string; host: string }> = [];
    const a = urlArea(calls, async (name, host) => {
      asked.push({ name, host });
      return { ok: true, value: LINK };
    });
    await a.request({ url: 'https://calendar.example.test/', auth: { secret: 'Calendar: Work', as: 'url' } });
    expect(asked).toEqual([{ name: 'Calendar: Work', host: 'calendar.example.test' }]);
    expect(calls).toEqual([{ url: LINK, headers: {} }]);
  });

  it('refuses a stored address on another host, or not on HTTPS, without sending', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const other = urlArea(calls, async () => ({ ok: true, value: 'https://evil.example.test/x.ics' }));
    await expect(other.request({ url: 'https://calendar.example.test/', auth: { secret: 'C', as: 'url' } })).rejects.toThrow(
      /"C" points at evil\.example\.test, not calendar\.example\.test/,
    );
    const plain = urlArea(calls, async () => ({ ok: true, value: 'http://calendar.example.test/x.ics' }));
    await expect(plain.request({ url: 'https://calendar.example.test/', auth: { secret: 'C', as: 'url' } })).rejects.toThrow(/not an HTTPS address/);
    const inside = urlArea(calls, async () => ({ ok: true, value: 'https://127.0.0.1/x.ics' }));
    await expect(inside.request({ url: 'https://calendar.example.test/', auth: { secret: 'C', as: 'url' } })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('reads only: a method other than GET, a body or a header is refused before any value', async () => {
    let asked = 0;
    const a = urlArea([], async () => {
      asked++;
      return { ok: true, value: LINK };
    });
    await expect(a.request({ url: 'https://calendar.example.test/', method: 'POST', auth: { secret: 'C', as: 'url' } })).rejects.toThrow(/only read/);
    await expect(a.request({ url: 'https://calendar.example.test/', body: 'x', auth: { secret: 'C', as: 'url' } })).rejects.toThrow(/only read/);
    await expect(a.request({ url: 'https://calendar.example.test/', auth: { secret: 'C', as: 'url', header: 'X' } })).rejects.toThrow(/not both/);
    await expect(a.request({ url: 'http://calendar.example.test/', auth: { secret: 'C', as: 'url' } })).rejects.toThrow(/HTTPS/);
    expect(asked).toBe(0);
  });

  it('an error quoting the address says the secret’s name instead', async () => {
    const failing = () => async (url: string) => {
      throw new Error(`connect ETIMEDOUT for ${url}`);
    };
    const a = urlArea([], async () => ({ ok: true, value: LINK }), failing);
    const err = await a.request({ url: 'https://calendar.example.test/', auth: { secret: 'Calendar: Work', as: 'url' } }).catch((e: Error) => e) as Error;
    expect(String(err.message)).toBe('connect ETIMEDOUT for ‹secret:Calendar: Work›');
    expect(String(err.message)).not.toContain('private-');
  });

  it('a pending approval is the same typed error', async () => {
    const a = urlArea([], async () => ({ pending: 'action-2' }));
    const err = await a.request({ url: 'https://calendar.example.test/', auth: { secret: 'C', as: 'url' } }).catch((e) => e);
    expect(err).toBeInstanceOf(SecretPendingError);
  });
});

describe('the http.url destination', () => {
  it('checks the plugin and the host, and describes both', () => {
    registerHttpUrlDestination();
    const destination = secretDestination(HTTP_URL_KIND)!;
    expect(destination.plugin).toBe(HTTP_HEADER_PLUGIN);
    const bound = { plugin: 'calendar', host: 'calendar.google.com' };
    expect(destination.checkTarget({ plugin: 'calendar', host: 'calendar.google.com' }, bound, {} as never)).toBe(true);
    expect(destination.checkTarget({ plugin: 'weather', host: 'calendar.google.com' }, bound, {} as never)).toBe(false);
    expect(destination.checkTarget({ plugin: 'calendar', host: 'evil.test' }, bound, {} as never)).toBe(false);
    expect(destination.describe(bound)).toBe('the address of requests calendar makes to calendar.google.com');
    expect(isOwnUrlBinding({ kind: HTTP_URL_KIND, target: bound }, 'calendar')).toBe(true);
    expect(isOwnUrlBinding({ kind: HTTP_URL_KIND, target: bound }, 'weather')).toBe(false);
    expect(isOwnUrlBinding({ kind: HTTP_HEADER_KIND, target: bound }, 'calendar')).toBe(false);
    resetSecretDestinations();
  });
});
