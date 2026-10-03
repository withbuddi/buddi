/**
 * A plugin's OAuth sign-in (host API 1.28) against a fake Google token
 * endpoint: the loopback answer and the pasted one, a declined consent, a
 * foreign state, missing scopes; then `fresh` — no refresh while the token
 * lasts, one when it is about to expire, one (and only one) after a 401, the
 * provider's refusal marking the sign-in out, and a passing failure leaving it
 * as it was.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryVault, isSignInExpired, type OAuthProvider } from '@buddi/core';
import { createPluginSignInService } from './plugin-sign-in.js';
import type { HttpTransport } from './transport.js';

interface TokenCall {
  grant: string;
  params: URLSearchParams;
}

/** Google's token endpoint, as far as a Desktop client sees it. */
class FakeGoogle {
  calls: TokenCall[] = [];
  /** What the next refresh answers: a status and Google's error, or tokens. */
  refreshAnswer: { status: number; error?: string } | null = null;
  grantScopes = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  codes = new Map<string, { verifier: string; redirect: string }>();
  issued = 0;
  server!: Server;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const grant = params.get('grant_type') ?? '';
        this.calls.push({ grant, params });
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (params.get('client_id') !== 'client-1' || params.get('client_secret') !== 'shh') return json(401, { error: 'invalid_client' });
        if (grant === 'authorization_code') {
          const code = this.codes.get(params.get('code') ?? '');
          if (!code || code.redirect !== params.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
          this.codes.delete(params.get('code')!);
          this.issued++;
          return json(200, { access_token: `access-${this.issued}`, refresh_token: 'refresh-1', expires_in: 3599, scope: this.grantScopes, token_type: 'Bearer' });
        }
        if (grant === 'refresh_token') {
          if (this.refreshAnswer) return json(this.refreshAnswer.status, this.refreshAnswer.error ? { error: this.refreshAnswer.error } : {});
          if (params.get('refresh_token') !== 'refresh-1') return json(400, { error: 'invalid_grant' });
          this.issued++;
          return json(200, { access_token: `access-${this.issued}`, expires_in: 3599, scope: this.grantScopes, token_type: 'Bearer' });
        }
        json(400, { error: 'unsupported_grant_type' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

const transport: HttpTransport = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string | Buffer }) =>
  fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body as string } : {}) })) as unknown as HttpTransport;

const google = new FakeGoogle();
let provider: OAuthProvider;
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];

beforeAll(async () => {
  await google.start();
  provider = {
    label: 'Google',
    authorizationEndpoint: `${google.url}/o/oauth2/v2/auth`,
    tokenEndpoint: `${google.url}/token`,
    authorizeExtra: { access_type: 'offline', prompt: 'consent' },
    apiHosts: ['www.googleapis.com'],
  };
});
afterAll(() => google.server.close());
beforeEach(() => {
  google.calls = [];
  google.refreshAnswer = null;
});

/** What Google's consent page does once the owner allows: a code, sent back to the redirect with the state. */
function consent(authorizeUrl: string): { code: string; state: string; redirect: string } {
  const url = new URL(authorizeUrl);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  const redirect = url.searchParams.get('redirect_uri')!;
  google.codes.set(code, { verifier: '', redirect });
  return { code, state: url.searchParams.get('state')!, redirect };
}

describe('signing in', () => {
  it('asks Google for consent with PKCE, offline access and the scopes, and takes the answer on the loopback port', async () => {
    const service = createPluginSignInService({ transport });
    const saved: string[] = [];
    const started = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async (e) => void saved.push(e) });
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${google.url}/o/oauth2/v2/auth`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(SCOPES.join(' '));
    expect(started.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(service.status('calendar', started.id)).toEqual({ state: 'waiting' });
    expect(service.status('news', started.id)).toBeUndefined();

    const { code, state, redirect } = consent(started.authorizeUrl);
    const page = await fetch(`${redirect}?state=${state}&code=${code}&scope=x`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Signed in to Google');
    expect(service.status('calendar', started.id)?.state).toBe('signed-in');
    const envelope = JSON.parse(saved[0]!);
    expect(envelope).toMatchObject({ version: 1, state: 'ready', refreshToken: 'refresh-1', clientId: 'client-1', extra: { tokenEndpoint: provider.tokenEndpoint, clientSecret: 'shh' } });
    const exchange = google.calls.find((c) => c.grant === 'authorization_code')!;
    expect(exchange.params.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange.params.get('redirect_uri')).toBe(started.redirectUri);
    // The listener is gone once the sign-in is over.
    await expect(fetch(`${redirect}?state=${state}&code=${code}`)).rejects.toThrow();
  });

  it('takes the pasted address when the browser was on another computer, once', async () => {
    const service = createPluginSignInService({ transport });
    const saved: string[] = [];
    const started = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async (e) => void saved.push(e) });
    const { code, state, redirect } = consent(started.authorizeUrl);
    await expect(service.finish('calendar', started.id, `${redirect}?state=wrong&code=${code}`)).rejects.toThrow(/another sign-in/);
    await expect(service.finish('calendar', started.id, `${redirect}?state=${state}`)).rejects.toThrow(/no sign-in code/);
    const status = await service.finish('calendar', started.id, `  ${redirect}?state=${state}&code=${code}&scope=x  `);
    expect(status.state).toBe('signed-in');
    expect(saved).toHaveLength(1);
    expect(await service.finish('calendar', started.id, `${redirect}?state=${state}&code=${code}`)).toMatchObject({ state: 'signed-in' });
    expect(google.calls.filter((c) => c.grant === 'authorization_code')).toHaveLength(1);
  });

  it('takes the code alone', async () => {
    const service = createPluginSignInService({ transport });
    const started = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async () => {} });
    const { code } = consent(started.authorizeUrl);
    expect((await service.finish('calendar', started.id, code)).state).toBe('signed-in');
  });

  it('a declined consent fails in words; a foreign state does not end the sign-in', async () => {
    const service = createPluginSignInService({ transport });
    const started = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async () => {} });
    const { state, redirect } = consent(started.authorizeUrl);
    expect((await fetch(`${redirect}?state=nope&code=x`)).status).toBe(400);
    expect(service.status('calendar', started.id)?.state).toBe('waiting');
    expect((await fetch(`${redirect}favicon.ico`)).status).toBe(404);
    const page = await fetch(`${redirect}?state=${state}&error=access_denied`);
    expect(await page.text()).toContain('did not allow');
    expect(service.status('calendar', started.id)).toMatchObject({ state: 'failed', problem: expect.stringMatching(/did not allow buddi/) });
  });

  it('fails a sign-in that did not grant every scope, and a used code', async () => {
    const service = createPluginSignInService({ transport });
    google.grantScopes = SCOPES[1]!;
    try {
      const started = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async () => {} });
      const { code } = consent(started.authorizeUrl);
      expect(await service.finish('calendar', started.id, code)).toMatchObject({ state: 'failed', problem: expect.stringMatching(/tick every box/) });
    } finally {
      google.grantScopes = SCOPES.join(' ');
    }
    const again = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async () => {} });
    expect(await service.finish('calendar', again.id, 'code-never-issued')).toMatchObject({ state: 'failed', problem: expect.stringMatching(/works once/) });
  });

  it('a client Google does not know is said as such', async () => {
    const service = createPluginSignInService({ transport });
    const started = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', scopes: SCOPES, save: async () => {} });
    const { code } = consent(started.authorizeUrl);
    expect(await service.finish('calendar', started.id, code)).toMatchObject({ state: 'failed', problem: expect.stringMatching(/client id or secret is wrong or missing/) });
  });

  it('a second sign-in replaces the waiting one; cancel drops it', async () => {
    const service = createPluginSignInService({ transport });
    const first = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', scopes: SCOPES, save: async () => {} });
    const second = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', scopes: SCOPES, save: async () => {} });
    expect(service.status('calendar', first.id)?.state).toBe('expired');
    service.cancel('calendar', second.id);
    expect(service.status('calendar', second.id)).toBeUndefined();
    expect(await service.finish('calendar', second.id, 'whatever-code')).toMatchObject({ state: 'expired' });
  });

  it('an exchange still in flight when its sign-in is replaced or cancelled saves nothing', async () => {
    // A slow token endpoint that does not stop when asked: what matters is that the answer is not kept.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = (async (url: string, init: never) => { await gate; return transport(url, init); }) as unknown as HttpTransport;
    const service = createPluginSignInService({ transport: slow });
    const saved: string[] = [];
    const first = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async (e) => void saved.push(`first:${e}`) });
    const pendingFirst = service.finish('calendar', first.id, consent(first.authorizeUrl).code);
    await new Promise((r) => setTimeout(r, 20));
    const second = await service.begin({ plugin: 'calendar', provider, clientId: 'client-1', clientSecret: 'shh', scopes: SCOPES, save: async (e) => void saved.push(`second:${e}`) });
    const pendingSecond = service.finish('calendar', second.id, consent(second.authorizeUrl).code);
    await new Promise((r) => setTimeout(r, 20));
    service.cancel('calendar', second.id);
    release();
    expect(await pendingFirst).toMatchObject({ state: 'expired', problem: expect.stringMatching(/newer sign-in replaced/) });
    expect(await pendingSecond).toMatchObject({ state: 'expired', problem: expect.stringMatching(/cancelled/) });
    expect(saved).toEqual([]);
  });
});

describe('fresh', () => {
  const REF = 'OWNER_SECRET_1';
  const envelope = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, state: 'ready', accessToken: 'access-old', refreshToken: 'refresh-1', expiresAt: Date.now() + 3600_000, clientId: 'client-1', extra: { tokenEndpoint: provider.tokenEndpoint, clientSecret: 'shh' }, ...over });

  it('hands the stored token while it lasts, and refreshes one about to expire', async () => {
    const service = createPluginSignInService({ transport });
    const vault = createMemoryVault();
    await vault.set(REF, envelope());
    expect(await service.fresh(vault, REF, 'G')).toEqual({ accessToken: 'access-old', refreshed: false });
    expect(google.calls).toHaveLength(0);
    await vault.set(REF, envelope({ expiresAt: Date.now() + 60_000 }));
    const fresh = await service.fresh(vault, REF, 'G');
    expect(fresh.refreshed).toBe(true);
    expect(fresh.accessToken).toMatch(/^access-\d+$/);
    const stored = JSON.parse((await vault.get(REF))!);
    expect(stored).toMatchObject({ accessToken: fresh.accessToken, refreshToken: 'refresh-1', state: 'ready' });
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 3000_000);
  });

  it('refreshes once after a 401, however many requests saw it', async () => {
    const service = createPluginSignInService({ transport });
    const vault = createMemoryVault();
    await vault.set(REF, envelope());
    const [a, b] = await Promise.all([
      service.fresh(vault, REF, 'G', { rejected: 'access-old' }),
      service.fresh(vault, REF, 'G', { rejected: 'access-old' }),
    ]);
    expect(a.accessToken).toBe(b.accessToken);
    expect(a.accessToken).not.toBe('access-old');
    expect(google.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
  });

  it('a refused refresh marks the sign-in out: typed, and Google is not asked again', async () => {
    const service = createPluginSignInService({ transport });
    const vault = createMemoryVault();
    await vault.set(REF, envelope({ expiresAt: 0 }));
    google.refreshAnswer = { status: 400, error: 'invalid_grant' };
    const err = await service.fresh(vault, REF, 'Calendar sign-in: Google').catch((e: unknown) => e);
    expect(isSignInExpired(err)).toBe(true);
    expect(String((err as Error).message)).not.toContain('refresh-1');
    expect(JSON.parse((await vault.get(REF))!).extra.signedOut).toBe('invalid_grant');
    google.calls = [];
    expect(isSignInExpired(await service.fresh(vault, REF, 'G').catch((e: unknown) => e))).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it('a passing failure leaves the sign-in as it was, to try again', async () => {
    const service = createPluginSignInService({ transport });
    const vault = createMemoryVault();
    const before = envelope({ expiresAt: 0 });
    await vault.set(REF, before);
    google.refreshAnswer = { status: 503 };
    const err = await service.fresh(vault, REF, 'G').catch((e: unknown) => e);
    expect(isSignInExpired(err)).toBe(false);
    expect(String(err)).toMatch(/tries again/);
    expect(await vault.get(REF)).toBe(before);
    google.refreshAnswer = null;
    expect((await service.fresh(vault, REF, 'G')).refreshed).toBe(true);
  });

  it('an empty or unreadable entry is a sign-in to make again', async () => {
    const service = createPluginSignInService({ transport });
    const vault = createMemoryVault();
    expect(isSignInExpired(await service.fresh(vault, REF, 'G').catch((e: unknown) => e))).toBe(true);
    await vault.set(REF, 'not json');
    expect(isSignInExpired(await service.fresh(vault, REF, 'G').catch((e: unknown) => e))).toBe(true);
  });
});
