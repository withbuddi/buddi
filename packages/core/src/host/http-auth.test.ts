/**
 * `http.header` (docs/specs/owner-secrets.md §3): the header inserted by the
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