import { describe, expect, it, vi } from 'vitest';
import { CodexOAuthProtocol, codexAccountEmail, codexAccountId, codexAuthJson, codexTokenExpiry, readCodexTokens } from './codex-oauth.js';
import type { HttpTransport, TransportResponse } from './transport.js';

function fakeJwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}
const access = (account = 'acct-1', exp = 2_000_000) => fakeJwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account } });

function reply(status: number, data: unknown): TransportResponse {
  return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null },
    json: async () => data, text: async () => JSON.stringify(data), arrayBuffer: async () => new ArrayBuffer(0) };
}
function transport(...replies: TransportResponse[]) {
  const send = vi.fn<HttpTransport>();
  for (const r of replies) send.mockResolvedValueOnce(r);
  return send;
}

describe('JWT claims', () => {
  it('reads the account id and expiry, and tolerates garbage', () => {
    expect(codexAccountId(access('acct-9'))).toBe('acct-9');
    expect(codexTokenExpiry(access('a', 1234))).toBe(1_234_000);
    for (const bad of ['', 'x', 'a.b.c', fakeJwt({}), fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'has space' } })]) {
      expect(codexAccountId(bad)).toBeUndefined();
    }
    expect(codexTokenExpiry('nope')).toBe(0);
  });
});

describe('device sign-in', () => {
  it('starts, keyed by device_auth_id, with the server interval', async () => {
    const send = transport(reply(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '7' }));
    const start = await new CodexOAuthProtocol(send, () => 1000).startDevice();
    expect(start).toEqual({ deviceAuthId: 'dev-1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', intervalMs: 7000, expiresAt: 1000 + 15 * 60_000 });
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  });
  it('explains a 404 and hides other bodies', async () => {
    await expect(new CodexOAuthProtocol(transport(reply(404, {}))).startDevice()).rejects.toThrow('Device code sign-in is not enabled');
    await expect(new CodexOAuthProtocol(transport(reply(500, { secret: 'SECRET' }))).startDevice()).rejects.not.toThrow('SECRET');
    await expect(new CodexOAuthProtocol(transport(reply(200, { device_auth_id: 'x' }))).startDevice()).rejects.toThrow('could not start');
  });
  it('maps poll answers', async () => {
    const p = new CodexOAuthProtocol(transport(
      reply(403, {}), reply(404, {}), reply(400, { error: { code: 'deviceauth_authorization_pending' } }),
      reply(400, { error: 'slow_down' }), reply(200, { authorization_code: 'code-1', code_verifier: 'ver-1' }),
      reply(400, { error: 'access_denied', detail: 'SECRET' }),
    ));
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await p.pollDevice('dev-1', 'ABCD-1234'));
    expect(results.slice(0, 5)).toEqual(['pending', 'pending', 'pending', 'slow_down', { code: 'code-1', verifier: 'ver-1' }]);
    expect(results[5]).toMatchObject({ denied: expect.stringContaining('declined') });
    expect(JSON.stringify(results[5])).not.toContain('SECRET');
  });
  it('exchanges the code at the token endpoint with the device redirect', async () => {
    const send = transport(reply(200, { access_token: access(), refresh_token: 'r1', id_token: fakeJwt({}), expires_in: 3600 }));
    const tokens = await new CodexOAuthProtocol(send, () => 5000).exchange({ code: 'code-1', verifier: 'ver-1' });
    expect(tokens).toMatchObject({ version: 1, state: 'ready', refreshToken: 'r1', accountId: 'acct-1', expiresAt: 5000 + 3_600_000 });
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://auth.openai.com/oauth/token');
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', code_verifier: 'ver-1',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  });
  it('refuses tokens without an account id, and never echoes bodies', async () => {
    const p = new CodexOAuthProtocol(transport(reply(200, { access_token: fakeJwt({ exp: 9 }), refresh_token: 'r' }), reply(400, { error: 'SECRET' })));
    await expect(p.exchange({ code: 'c', verifier: 'v' })).rejects.toThrow('fresh sign-in');
    await expect(p.exchange({ code: 'c', verifier: 'v' })).rejects.not.toThrow('SECRET');
  });
  it('refresh rotates, keeps the old refresh token when none comes back, and expiry falls back to exp', async () => {
    const old = readCodexTokens(JSON.stringify({ version: 1, state: 'ready', accessToken: access(), refreshToken: 'r-old', accountId: 'acct-1', expiresAt: 1 }));
    const send = transport(reply(200, { access_token: access('acct-1', 7777), refresh_token: 'r-new' }), reply(200, { access_token: access('acct-1', 8888) }));
    const p = new CodexOAuthProtocol(send);
    const rotated = await p.refresh(old);
    expect(rotated).toMatchObject({ refreshToken: 'r-new', expiresAt: 7_777_000 });
    expect(new URLSearchParams(send.mock.calls[0]![1].body as string).get('refresh_token')).toBe('r-old');
    expect(await p.refresh(rotated)).toMatchObject({ refreshToken: 'r-new', expiresAt: 8_888_000 });
    await expect(new CodexOAuthProtocol(transport(reply(401, {}))).refresh(old)).rejects.toThrow('Reconnect');
  });
});

describe('vault envelope', () => {
  const envelope = { version: 1, state: 'ready', accessToken: access(), refreshToken: 'r1', accountId: 'acct-1', expiresAt: 99 };
  it('round-trips the envelope', () => {
    expect(readCodexTokens(JSON.stringify(envelope))).toEqual(envelope);
    expect(readCodexTokens(JSON.stringify({ ...envelope, state: 'refreshing' })).state).toBe('refreshing');
  });
  it('converts a legacy Codex auth.json, pretty-printed or hex-encoded', () => {
    const legacy = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: access('acct-2', 4242), refresh_token: 'r2', id_token: fakeJwt({}), account_id: 'acct-2' }, last_refresh: '2026-09-19T00:00:00Z' };
    const pretty = JSON.stringify(legacy, null, 2) + '\n';
    const expected = { version: 1, state: 'ready', accessToken: legacy.tokens.access_token, refreshToken: 'r2', idToken: legacy.tokens.id_token, accountId: 'acct-2', expiresAt: 4_242_000 };
    expect(readCodexTokens(pretty)).toEqual(expected);
    expect(readCodexTokens(Buffer.from(pretty).toString('hex'))).toEqual(expected);
    const noAccount = { ...legacy, tokens: { ...legacy.tokens, account_id: undefined } };
    expect(readCodexTokens(JSON.stringify(noAccount)).accountId).toBe('acct-2');
  });
  it.each([
    'not-json-SECRET', '{}', 'x'.repeat(140_000), 'deadbeef',
    JSON.stringify({ OPENAI_API_KEY: 'sk-SECRET', tokens: { access_token: 'a', refresh_token: 'b', account_id: 'c' } }),
    JSON.stringify({ tokens: { access_token: 'no-claims', refresh_token: 'b' } }),
    JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: 'a', refresh_token: 'b', account_id: 'c' } }),
    JSON.stringify({ version: 1, state: 'odd', accessToken: 'a', refreshToken: 'b', accountId: 'c', expiresAt: 1 }),
    JSON.stringify({ version: 1, state: 'ready', accessToken: 'a b', refreshToken: 'b', accountId: 'c', expiresAt: 1 }),
    JSON.stringify({ version: 1, state: 'ready', accessToken: 'a', refreshToken: 'b', expiresAt: 1 }),
  ])('rejects invalid shapes without echoing them (%#)', raw => {
    expect(() => readCodexTokens(raw)).toThrow('Invalid ChatGPT credential. Reconnect this account.');
  });
  it('renders the envelope as Codex auth.json that reads back to the same tokens', () => {
    const tokens = readCodexTokens(JSON.stringify({ ...envelope, idToken: 'id-1' }));
    const file = JSON.parse(codexAuthJson(tokens, () => 0));
    expect(file).toEqual({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'id-1', access_token: envelope.accessToken, refresh_token: 'r1', account_id: 'acct-1' }, last_refresh: '1970-01-01T00:00:00.000Z' });
    expect(readCodexTokens(JSON.stringify(file))).toMatchObject({ accessToken: envelope.accessToken, refreshToken: 'r1', accountId: 'acct-1', expiresAt: 2_000_000_000 });
  });
});

describe('codexAccountEmail', () => {
  it('reads the address from the id token, else the access token profile claim', () => {
    expect(codexAccountEmail(fakeJwt({ email: 'amen@example.com' }), access())).toBe('amen@example.com');
    expect(codexAccountEmail(undefined, fakeJwt({ 'https://api.openai.com/profile': { email: 'sam@example.com' } }))).toBe('sam@example.com');
    expect(codexAccountEmail(undefined, access())).toBeUndefined();
    expect(codexAccountEmail(fakeJwt({ email: 'not an address' }))).toBeUndefined();
    expect(codexAccountEmail('garbage')).toBeUndefined();
  });
});
