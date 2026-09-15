/**
 * The dashboard's pure parts: the binding, the ticket, the cookies, the
 * session store, the rate limit and the static path resolver.
 *
 * Everything here is arithmetic and string handling — the database-backed API
 * tests live in `web.db.test.ts`.
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryVault } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  isLoopback,
  webConfig,
  webEnabled,
  webUrl,
} from './config.js';
import { cookieHeader, parseCookies } from './http.js';
import { RateLimiter, SessionStore, SpentTickets } from './sessions.js';
import { resolveAsset } from './static.js';
import { toStreamEvent } from './stream.js';
import { ensureWebToken, mintTicket, verifyTicket, webTokenExists, webTokenFile } from './token.js';

describe('binding', () => {
  it('is loopback and 4317 unless the owner says otherwise', () => {
    const config = webConfig({});
    expect(config).toEqual({ enabled: true, host: DEFAULT_WEB_HOST, port: DEFAULT_WEB_PORT });
    expect(isLoopback(config.host)).toBe(true);
  });

  it('reads the host and port from the environment', () => {
    expect(webConfig({ BUDDI_WEB_HOST: '0.0.0.0', BUDDI_WEB_PORT: '8080' })).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 8080,
    });
  });

  it('ignores a port that is not a port', () => {
    expect(webConfig({ BUDDI_WEB_PORT: 'banana' }).port).toBe(DEFAULT_WEB_PORT);
    expect(webConfig({ BUDDI_WEB_PORT: '99999' }).port).toBe(DEFAULT_WEB_PORT);
  });

  it('is on by default and off only when told', () => {
    expect(webEnabled({})).toBe(true);
    for (const value of ['0', 'off', 'false', 'no', 'OFF']) {
      expect(webEnabled({ BUDDI_WEB: value })).toBe(false);
    }
    expect(webEnabled({ BUDDI_WEB: '1' })).toBe(true);
  });

  it('allows only the bound address (and the other spellings of loopback)', () => {
    const origins = allowedOrigins({ host: '127.0.0.1', port: 4317 });
    expect(origins).toContain('http://127.0.0.1:4317');
    expect(origins).toContain('http://localhost:4317');
    expect(origins).not.toContain('http://example.com');
    // A non-loopback binding does not silently accept localhost.
    expect(allowedOrigins({ host: '10.0.0.4', port: 4317 })).toEqual(['http://10.0.0.4:4317']);
  });

  it('never hands a human an address they cannot open', () => {
    expect(webUrl({ host: '0.0.0.0', port: 4317 })).toBe('http://127.0.0.1:4317/');
    expect(webUrl({ host: '127.0.0.1', port: 4317 }, 'abc.1.def')).toBe(
      'http://127.0.0.1:4317/?t=abc.1.def',
    );
  });
});

describe('the token', () => {
  const env = (): NodeJS.ProcessEnv => ({
    BUDDI_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'buddi-web-')),
    BUDDI_VAULT: 'none',
  });

  it('is created once in the vault and found again', async () => {
    const vault = createMemoryVault();
    const first = await ensureWebToken({ env: env(), vault });
    expect(first.created).toBe(true);
    expect(first.source).toBe('vault');
    expect(first.token.length).toBeGreaterThan(32);

    const second = await ensureWebToken({ env: env(), vault });
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('falls back to a 0600 file when there is no usable vault', async () => {
    const e = env();
    const created = await ensureWebToken({ env: e, vault: undefined });
    expect(created.source).toBe('file');
    const file = webTokenFile(e);
    expect(readFileSync(file, 'utf8').trim()).toBe(created.token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await webTokenExists({ env: e, vault: undefined })).toBe('file');
  });

  it('reports no token rather than creating one when asked read-only', async () => {
    expect(await webTokenExists({ env: env(), vault: undefined })).toBeNull();
  });

  it('never treats the vault placeholder as a token', async () => {
    const e = { ...env(), BUDDI_WEB_TOKEN: '"<vault>"' };
    const vault = createMemoryVault();
    const found = await ensureWebToken({ env: e, vault });
    expect(found.source).toBe('vault');
    expect(found.token).not.toContain('vault');
  });
});

describe('tickets', () => {
  const token = 'a-long-random-token-value';

  it('verify, and carry a nonce', () => {
    const ticket = mintTicket(token);
    const check = verifyTicket(token, ticket);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.nonce).not.toBe('');
  });

  it('do not verify under another token, or when edited', () => {
    const ticket = mintTicket(token);
    expect(verifyTicket('another-token', ticket).ok).toBe(false);
    expect(verifyTicket(token, `${ticket}x`).ok).toBe(false);
    expect(verifyTicket(token, 'nonsense').ok).toBe(false);
  });

  it('expire', () => {
    const now = new Date('2026-09-14T10:00:00Z');
    const ticket = mintTicket(token, now, 60_000);
    expect(verifyTicket(token, ticket, new Date(now.getTime() + 30_000)).ok).toBe(true);
    const late = verifyTicket(token, ticket, new Date(now.getTime() + 61_000));
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe('expired');
  });

  it('are spendable exactly once', () => {
    const spent = new SpentTickets();
    const expiry = new Date(Date.now() + 60_000);
    expect(spent.spend('nonce-1', expiry)).toBe(true);
    expect(spent.spend('nonce-1', expiry)).toBe(false);
    expect(spent.spend('nonce-2', expiry)).toBe(true);
  });
});

describe('sessions', () => {
  it('hands out a session and a csrf token that must match exactly', () => {
    const store = new SessionStore();
    const session = store.create();
    expect(store.get(session.id)?.id).toBe(session.id);
    expect(SessionStore.csrfMatches(session, session.csrf)).toBe(true);
    expect(SessionStore.csrfMatches(session, `${session.csrf}x`)).toBe(false);
    expect(SessionStore.csrfMatches(session, '')).toBe(false);
    expect(SessionStore.csrfMatches(session, undefined)).toBe(false);
  });

  it('expires, and forgets', () => {
    const start = new Date('2026-09-14T10:00:00Z');
    const store = new SessionStore(1_000);
    const session = store.create(start);
    expect(store.get(session.id, new Date(start.getTime() + 500))).toBeDefined();
    expect(store.get(session.id, new Date(start.getTime() + 2_000))).toBeUndefined();
    expect(store.get('not-a-session')).toBeUndefined();
  });
});

describe('the auth rate limit', () => {
  it('blocks an address after enough failures and lets it back in next window', () => {
    const now = new Date('2026-09-14T10:00:00Z');
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.blocked('a', now)).toBe(false);
    limiter.fail('a', now);
    limiter.fail('a', now);
    expect(limiter.blocked('a', now)).toBe(false);
    limiter.fail('a', now);
    expect(limiter.blocked('a', now)).toBe(true);
    // Another address is unaffected, and the window ends.
    expect(limiter.blocked('b', now)).toBe(false);
    expect(limiter.blocked('a', new Date(now.getTime() + 61_000))).toBe(false);
  });

  it('forgets an address that succeeded', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.fail('a');
    expect(limiter.blocked('a')).toBe(true);
    limiter.reset('a');
    expect(limiter.blocked('a')).toBe(false);
  });
});

describe('cookies', () => {
  it('are HttpOnly and SameSite=Strict, and the csrf one is readable', () => {
    expect(cookieHeader('buddi_session', 'abc', { httpOnly: true })).toBe(
      'buddi_session=abc; Path=/; SameSite=Strict; HttpOnly',
    );
    expect(cookieHeader('buddi_csrf', 'xyz', { httpOnly: false })).toBe(
      'buddi_csrf=xyz; Path=/; SameSite=Strict',
    );
  });

  it('parse back', () => {
    expect(parseCookies('a=1; b=two%20words; junk')).toEqual({ a: '1', b: 'two words' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('static files', () => {
  const root = '/srv/buddi/packages/web/dist';

  it('resolve inside the build', () => {
    expect(resolveAsset(root, '/assets/index-abc.js')).toBe(`${root}/assets/index-abc.js`);
    expect(resolveAsset(root, '/')).toBe(`${root}/index.html`);
  });

  it('refuse to escape it', () => {
    expect(resolveAsset(root, '/../../../etc/passwd')).toBeNull();
    expect(resolveAsset(root, '/%2e%2e%2f%2e%2e%2fetc/passwd')).toBeNull();
  });
});

/**
 * What a failed run looks like on the wire.
 *
 * The page draws `message`. `error` is on the frame for the record — a page
 * that rendered it would be showing the owner `fetch failed`, which is the
 * thing this whole change exists to stop.
 */
describe('the stream projection of a failed run', () => {
  const row = (payload: Record<string, unknown>) => ({
    id: '1',
    kind: 'chat.run.failed',
    payload,
    createdAt: new Date('2026-09-15T17:37:00Z'),
  });

  it('carries the sentence a person reads, and the class it was', () => {
    const { event, data } = toStreamEvent(
      row({
        runId: 'r1',
        stopped: 'failed',
        message: "I couldn't reach the model just now.",
        failureClass: 'transient',
        error: 'fetch failed <- Error: other side closed [UND_ERR_SOCKET]',
      }),
    );
    expect(event).toBe('run.finished');
    expect(data.stopped).toBe('failed');
    expect(data.message).toBe("I couldn't reach the model just now.");
    expect(data.failureClass).toBe('transient');
  });

  it('says nothing about a message on a run that simply ended', () => {
    const { data } = toStreamEvent({
      id: '2',
      kind: 'run.finished',
      payload: { runId: 'r2', stopped: 'end_turn', turns: 1 },
      createdAt: new Date('2026-09-15T17:37:00Z'),
    });
    expect(data.message).toBeUndefined();
    expect(data.failureClass).toBeUndefined();
  });
});
