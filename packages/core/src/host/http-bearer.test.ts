/**
 * `http.bearer` (host API 1.28, docs/owner-secrets.md §3): an OAuth sign-in
 * core made for a plugin, sent as a Bearer token by the area itself — HTTPS,
 * an API's verbs, a small body, a budget — and a 401 answered once with a
 * fresh token; a sign-in the provider refused is a typed error.
 */
import { describe, expect, it } from 'vitest';
import { secretDestination } from '../secrets/destinations.js';
import { SignInExpiredError, isSignInExpired } from '../plugin/sign-in.js';
import {
  HTTP_BEARER_KIND,
  HTTP_HEADER_PLUGIN,
  createBasicBudget,
  createHttpArea,
  isOwnBearerBinding,
  registerHttpBearerDestination,
} from './http.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A transport that answers each call with the next status, recording what it was handed. */
function transportOf(calls: Call[], statuses: number[]) {
  return async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const status = statuses.shift() ?? 200;
    return {
      ok: status < 400,
      status,
      statusText: String(status),
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

function areaOf(opts: {
  calls: Call[];
  statuses?: number[];
  deliver: (name: string, host: string, rejected?: string) => Promise<{ ok: true; value: string } | { pending: string } | { refused: string }>;
  perMinute?: number;
}) {
  return createHttpArea({
    plugin: 'calendar',
    network: ['www.googleapis.com'],
    log: () => {},
    transport: (() => transportOf(opts.calls, opts.statuses ?? [])) as never,
    secrets: { deliverFor: async () => ({ refused: 'no' }), deliverBearerFor: opts.deliver },
    bearerBudget: createBasicBudget(opts.perMinute ?? 300),
  });
}

const URL_ = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

describe('a bearer sign-in', () => {
  it('sends the delivered access token, replacing any Authorization the caller set', async () => {
    const calls: Call[] = [];
    const asked: Array<{ name: string; host: string; rejected?: string }> = [];
    const a = areaOf({
      calls,
      deliver: async (name, host, rejected) => {
        asked.push({ name, host, ...(rejected ? { rejected } : {}) });
        return { ok: true, value: 'access-1' };
      },
    });
    const res = await a.request({ url: URL_, headers: { authorization: 'mine', accept: 'application/json', Host: 'evil.test' }, auth: { secret: 'Google', as: 'bearer' } });
    expect(res.status).toBe(200);
    expect(asked).toEqual([{ name: 'Google', host: 'www.googleapis.com' }]);
    expect(calls[0]?.headers).toEqual({ accept: 'application/json', Authorization: 'Bearer access-1' });
  });

  it('answers a 401 once: a fresh token, the request sent again', async () => {
    const calls: Call[] = [];
    const asked: Array<string | undefined> = [];
    const tokens = ['access-1', 'access-2'];
    const a = areaOf({
      calls,
      statuses: [401, 200],
      deliver: async (_name, _host, rejected) => {
        asked.push(rejected);
        return { ok: true, value: tokens.shift()! };
      },
    });
    const res = await a.request({ url: URL_, method: 'PATCH', body: '{}', auth: { secret: 'Google', as: 'bearer' } });
    expect(res.status).toBe(200);
    expect(asked).toEqual([undefined, 'access-1']);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(calls.every((c) => c.method === 'PATCH')).toBe(true);
  });

  it('a second 401 is the answer: no loop', async () => {
    const calls: Call[] = [];
    const a = areaOf({ calls, statuses: [401, 401], deliver: async () => ({ ok: true, value: 'access' }) });
    const res = await a.request({ url: URL_, auth: { secret: 'Google', as: 'bearer' } });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);
  });

  it('refuses plain HTTP, another verb, a big body, a header or a user name, before any token', async () => {
    const calls: Call[] = [];
    let asked = 0;
    const a = areaOf({ calls, deliver: async () => (asked++, { ok: true, value: 'x' }) });
    await expect(a.request({ url: 'http://www.googleapis.com/x', auth: { secret: 'G', as: 'bearer' } })).rejects.toThrow(/HTTPS/);
    await expect(a.request({ url: URL_, method: 'PROPFIND', auth: { secret: 'G', as: 'bearer' } })).rejects.toThrow(/not PROPFIND/);
    await expect(a.request({ url: URL_, method: 'POST', body: 'x'.repeat(300 * 1024), auth: { secret: 'G', as: 'bearer' } })).rejects.toThrow(/KiB/);
    await expect(a.request({ url: URL_, auth: { secret: 'G', as: 'bearer', header: 'X-Token' } })).rejects.toThrow(/Authorization/);
    await expect(a.request({ url: URL_, auth: { secret: 'G', as: 'bearer', username: 'me' } })).rejects.toThrow(/user name/);
    expect(asked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a sign-in the provider refused is the typed error, and nothing is sent', async () => {
    const calls: Call[] = [];
    const a = areaOf({
      calls,
      deliver: async (name) => {
        throw new SignInExpiredError(name);
      },
    });
    const err = await a.request({ url: URL_, auth: { secret: 'Google', as: 'bearer' } }).catch((e: unknown) => e);
    expect(isSignInExpired(err)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('keeps to its budget per secret per minute, and a refusal gives its stamp back', async () => {
    const calls: Call[] = [];
    let refuse = true;
    const a = areaOf({ calls, perMinute: 2, deliver: async () => (refuse ? { refused: 'no' } : { ok: true, value: 'x' }) });
    await expect(a.request({ url: URL_, auth: { secret: 'G', as: 'bearer' } })).rejects.toThrow('no');
    refuse = false;
    await a.request({ url: URL_, auth: { secret: 'G', as: 'bearer' } });
    await a.request({ url: URL_, auth: { secret: 'G', as: 'bearer' } });
    await expect(a.request({ url: URL_, auth: { secret: 'G', as: 'bearer' } })).rejects.toThrow(/too many/);
  });

  it('a process that cannot deliver says so', async () => {
    const a = createHttpArea({ plugin: 'calendar', network: [], log: () => {}, transport: undefined });
    await expect(a.request({ url: URL_, auth: { secret: 'G', as: 'bearer' } })).rejects.toThrow(/cannot deliver/);
  });
});

describe('the http.bearer destination', () => {
  it('checks the plugin and the host, and describes both', () => {
    registerHttpBearerDestination();
    const destination = secretDestination(HTTP_BEARER_KIND)!;
    expect(destination).toBeDefined();
    const bound = { plugin: 'calendar', host: 'www.googleapis.com' };
    expect(destination.checkTarget({ plugin: 'calendar', host: 'www.googleapis.com' }, bound, undefined as never)).toBe(true);
    expect(destination.checkTarget({ plugin: 'news', host: 'www.googleapis.com' }, bound, undefined as never)).toBe(false);
    expect(destination.checkTarget({ plugin: 'calendar', host: 'evil.test' }, bound, undefined as never)).toBe(false);
    expect(destination.describe(bound)).toBe('the sign-in calendar uses at www.googleapis.com');
    expect(isOwnBearerBinding({ kind: HTTP_BEARER_KIND, target: bound }, 'calendar')).toBe(true);
    expect(isOwnBearerBinding({ kind: HTTP_BEARER_KIND, target: bound }, 'news')).toBe(false);
    expect(HTTP_HEADER_PLUGIN).toBe('http');
  });
});
