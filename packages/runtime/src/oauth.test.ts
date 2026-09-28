import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryVault } from '@buddi/core';
import {
  authorizeUrl, canonicalResource, discoverAuthorization, OAuthCallbackError, OAuthClient, oauthState, parseCallback,
  parseWwwAuthenticate, pkcePair, readOAuthTokens, refreshDiscipline, registerClient, type OAuthTokens,
} from './oauth.js';
import type { HttpTransport, TransportResponse } from './transport.js';

function reply(status: number, data: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    json: async () => data, text: async () => JSON.stringify(data), arrayBuffer: async () => new ArrayBuffer(0) };
}
/** A fake network: URL → answer; anything else 404. */
function routes(map: Record<string, TransportResponse>) {
  return vi.fn<HttpTransport>(async (url) => map[url] ?? reply(404, {}));
}

describe('PKCE, state, authorize URL', () => {
  it('makes an S256 pair and fresh state; the verifier never enters the URL', () => {
    const p = pkcePair();
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
    expect(pkcePair().verifier).not.toBe(p.verifier);
    expect(oauthState()).not.toBe(oauthState());
    const url = new URL(authorizeUrl({ authorizationEndpoint: 'https://as.example/authorize?tenant=x', clientId: 'c1',
      redirectUri: 'http://127.0.0.1:9444/connections/callback', state: 's1', challenge: p.challenge, scopes: ['a', 'b'], resource: 'https://mcp.example/mcp' }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'c1', response_type: 'code', scope: 'a b',
      code_challenge_method: 'S256', code_challenge: p.challenge, state: 's1', resource: 'https://mcp.example/mcp', tenant: 'x' });
    expect(url.toString()).not.toContain(p.verifier);
  });
  it('parses a callback, checks state, and says why it refused', () => {
    const redirectUri = 'http://127.0.0.1:9444/connections/callback';
    expect(parseCallback(`${redirectUri}?code=abc&state=s1`, 's1', { redirectUri })).toEqual({ code: 'abc', state: 's1' });
    const reason = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as OAuthCallbackError).reason; } return 'ok'; };
    expect(reason(() => parseCallback(`${redirectUri}?code=abc&state=s2`, 's1', { redirectUri }))).toBe('state');
    expect(reason(() => parseCallback('https://evil.example/cb?code=abc&state=s1', 's1', { redirectUri }))).toBe('foreign');
    expect(reason(() => parseCallback(`${redirectUri}?error=access_denied&state=s1`, 's1', { redirectUri }))).toBe('denied');
    expect(reason(() => parseCallback('abc#s1', 's1'))).toBe('malformed');
    expect(parseCallback('abc#s1', 's1', { allowCodeHashState: true }).code).toBe('abc');
    expect(reason(() => parseCallback('http://evil.example/?code=a&state=s1', 's1'))).toBe('foreign');
  });
  it('reads WWW-Authenticate challenges', () => {
    expect(parseWwwAuthenticate('Bearer error="invalid_token", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", scope="read write"'))
      .toEqual({ scheme: 'bearer', params: { error: 'invalid_token', resource_metadata: 'https://mcp.example/.well-known/oauth-protected-resource', scope: 'read write' } });
    expect(parseWwwAuthenticate(null)).toBeUndefined();
    expect(canonicalResource('https://MCP.example/')).toBe('https://mcp.example');
  });
});

const AS = {
  issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token',
  registration_endpoint: 'https://auth.example/register', code_challenge_methods_supported: ['S256'], scopes_supported: ['repo'],
};

describe('discovery', () => {
  it('follows the challenge to resource metadata, then the authorization server', async () => {
    const send = routes({
      'https://mcp.example/meta': reply(200, { resource: 'https://mcp.example/mcp', authorization_servers: ['https://auth.example'], scopes_supported: ['repo'] }),
      'https://auth.example/.well-known/oauth-authorization-server': reply(200, AS),
    });
    const found = await discoverAuthorization('https://mcp.example/mcp', { transport: send, wwwAuthenticate: 'Bearer resource_metadata="https://mcp.example/meta"' });
    expect(found).toMatchObject({ resource: 'https://mcp.example/mcp', scopes: ['repo'],
      authorizationServer: { tokenEndpoint: 'https://auth.example/token', registrationEndpoint: 'https://auth.example/register' } });
    expect(send.mock.calls.map(([url]) => url)).toEqual(['https://mcp.example/meta', 'https://auth.example/.well-known/oauth-authorization-server']);
    expect(send.mock.calls[0]![1].method).toBe('GET');
  });
  it('without a challenge, tries the path-aware well-known, then the root; OIDC as a fallback', async () => {
    const send = routes({
      'https://mcp.example/.well-known/oauth-protected-resource': reply(200, { authorization_servers: ['https://auth.example/tenant'] }),
      'https://auth.example/.well-known/openid-configuration/tenant': reply(200, { ...AS, issuer: 'https://auth.example/tenant' }),
    });
    const found = await discoverAuthorization('https://mcp.example/mcp', { transport: send });
    expect(found.resource).toBe('https://mcp.example/mcp');
    expect(found.authorizationServer.issuer).toBe('https://auth.example/tenant');
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      'https://mcp.example/.well-known/oauth-protected-resource/mcp',
      'https://mcp.example/.well-known/oauth-protected-resource',
      'https://auth.example/.well-known/oauth-authorization-server/tenant',
      'https://auth.example/.well-known/openid-configuration/tenant',
    ]);
  });
  it('falls back to the server as its own authorization server', async () => {
    const send = routes({ 'https://mcp.example/.well-known/oauth-authorization-server': reply(200, { ...AS, issuer: 'https://mcp.example' }) });
    const found = await discoverAuthorization('https://mcp.example/mcp', { transport: send });
    expect(found.protectedResource).toBeUndefined();
    expect(found.authorizationServer.issuer).toBe('https://mcp.example');
  });
  it('refuses http, a foreign issuer, metadata for another resource, and no PKCE', async () => {
    await expect(discoverAuthorization('http://mcp.example/mcp', { transport: routes({}) })).rejects.toThrow('https');
    const withAs = (as: object) => routes({
      'https://mcp.example/.well-known/oauth-protected-resource': reply(200, { authorization_servers: ['https://auth.example'] }),
      'https://auth.example/.well-known/oauth-authorization-server': reply(200, as),
    });
    await expect(discoverAuthorization('https://mcp.example', { transport: withAs({ ...AS, issuer: 'https://evil.example' }) })).rejects.toThrow('another issuer');
    await expect(discoverAuthorization('https://mcp.example', { transport: withAs({ ...AS, code_challenge_methods_supported: undefined }) })).rejects.toThrow('PKCE');
    await expect(discoverAuthorization('https://mcp.example', { transport: withAs({ ...AS, token_endpoint: 'http://auth.example/token' }) })).rejects.toThrow('malformed');
    const other = routes({ 'https://mcp.example/.well-known/oauth-protected-resource': reply(200, { resource: 'https://evil.example', authorization_servers: ['https://auth.example'] }) });
    await expect(discoverAuthorization('https://mcp.example', { transport: other })).rejects.toThrow('another address');
    await expect(discoverAuthorization('https://mcp.example', { transport: routes({}) })).rejects.toThrow('did not say how to sign in');
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and keeps the id', async () => {
    const send = routes({ 'https://auth.example/register': reply(201, { client_id: 'dyn-1', client_name: 'buddi' }) });
    const client = await registerClient('https://auth.example/register', { redirect_uris: ['http://127.0.0.1:9444/connections/callback'] }, { transport: send });
    expect(client).toEqual({ clientId: 'dyn-1' });
    expect(JSON.parse(send.mock.calls[0]![1].body as string)).toEqual({ client_name: 'buddi', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1:9444/connections/callback'] });
  });
  it('explains a refusal without echoing the body', async () => {
    const send = routes({ 'https://auth.example/register': reply(403, { error: 'SECRET' }) });
    await expect(registerClient('https://auth.example/register', { redirect_uris: ['https://x.example/cb'] }, { transport: send })).rejects.toThrow(/refused.*client id/);
    await expect(registerClient('https://auth.example/register', { redirect_uris: ['https://x.example/cb'] }, { transport: send })).rejects.not.toThrow('SECRET');
  });
});

describe('OAuthClient', () => {
  const tokenUrl = 'https://auth.example/token';
  it('exchanges a code with resource and PKCE, then refreshes, keeping a refresh token that did not rotate', async () => {
    const send = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(reply(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 60, scope: 'repo', token_type: 'Bearer' }))
      .mockResolvedValueOnce(reply(200, { access_token: 'a2', expires_in: 60 }));
    const client = new OAuthClient({ tokenEndpoint: tokenUrl, clientId: 'dyn-1', resource: 'https://mcp.example/mcp', transport: send, now: () => 1000 });
    const tokens = await client.exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'https://x.example/cb' });
    expect(tokens).toEqual({ version: 1, state: 'ready', accessToken: 'a1', refreshToken: 'r1', expiresAt: 61_000, scopes: ['repo'], clientId: 'dyn-1', resource: 'https://mcp.example/mcp' });
    expect(Object.fromEntries(new URLSearchParams(send.mock.calls[0]![1].body as string))).toEqual({ client_id: 'dyn-1', grant_type: 'authorization_code',
      code: 'c', code_verifier: 'v', redirect_uri: 'https://x.example/cb', resource: 'https://mcp.example/mcp' });
    const rotated = await client.refresh(tokens);
    expect(rotated).toMatchObject({ accessToken: 'a2', refreshToken: 'r1', scopes: ['repo'] });
    expect(new URLSearchParams(send.mock.calls[1]![1].body as string).get('refresh_token')).toBe('r1');
  });
  it('without a refresh token or expiry: connected until a long assumed expiry; refresh refuses', async () => {
    const client = new OAuthClient({ tokenEndpoint: tokenUrl, clientId: 'c', transport: vi.fn<HttpTransport>().mockResolvedValue(reply(200, { access_token: 'a' })), now: () => 0 });
    const tokens = await client.exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'https://x.example/cb' });
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBe(365 * 86400_000);
    await expect(client.refresh(tokens)).rejects.toThrow('Reconnect');
  });
  it('refuses malformed answers with its own sentence, never the body, and never retries', async () => {
    const send = vi.fn<HttpTransport>().mockResolvedValue(reply(400, { error: 'SECRET' }));
    const client = new OAuthClient({ tokenEndpoint: tokenUrl, clientId: 'c', transport: send, messages: { exchange: 'Start again.' } });
    await expect(client.exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'https://x.example/cb' })).rejects.toThrow('Start again.');
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue(reply(200, { access_token: 'a', token_type: 'mac' }));
    await expect(client.exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'https://x.example/cb' })).rejects.toThrow('Start again.');
  });
});

describe('envelope', () => {
  it('reads, validates and adapts', () => {
    const t: OAuthTokens = { version: 1, state: 'ready', accessToken: 'a', expiresAt: 5, clientId: 'dyn-1', resource: 'https://mcp.example', extra: { idToken: 'x' } };
    expect(readOAuthTokens(JSON.stringify(t))).toEqual(t);
    expect(() => readOAuthTokens(JSON.stringify({ ...t, accessToken: 'has space' }), { invalidMessage: 'Nope.' })).toThrow('Nope.');
    expect(() => readOAuthTokens(JSON.stringify(t), { requireRefreshToken: true })).toThrow();
    expect(() => readOAuthTokens('{')).toThrow('Reconnect');
    const legacy = readOAuthTokens(JSON.stringify({ token: 'a' }), { adapt: (d) => ({ version: 1, state: 'ready', accessToken: d.token, expiresAt: 0 }) });
    expect(legacy.accessToken).toBe('a');
    expect(readOAuthTokens(JSON.stringify({ ...t, idToken: 'id' }), { keep: ['idToken'] }).extra).toEqual({ idToken: 'id' });
  });
});

describe('refreshDiscipline', () => {
  const ready: OAuthTokens = { version: 1, state: 'ready', accessToken: 'a1', refreshToken: 'r1', expiresAt: 1_000_000 };
  function fixture(now: number) {
    const vault = createMemoryVault();
    const refresh = vi.fn(async (t: OAuthTokens): Promise<OAuthTokens> => ({ ...t, accessToken: 'a2', refreshToken: 'r2', expiresAt: now + 3_600_000 }));
    const protocol = { read: (raw: string) => readOAuthTokens(raw), refresh };
    return { vault, refresh, run: (opts = {}) => refreshDiscipline(vault, 'ref', protocol, () => now, opts) };
  }
  it('returns ready tokens that are not near expiry without refreshing', async () => {
    const f = fixture(0); await f.vault.set('ref', JSON.stringify(ready));
    expect((await f.run()).accessToken).toBe('a1'); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('refreshes within five minutes of expiry, saves the rotated pair, and rechecks first', async () => {
    const f = fixture(800_000); await f.vault.set('ref', JSON.stringify(ready));
    const check = vi.fn(async () => {});
    expect((await f.run({ beforeRefresh: check })).accessToken).toBe('a2');
    expect(check).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await f.vault.get('ref'))!)).toMatchObject({ state: 'ready', refreshToken: 'r2' });
  });
  it('leaves the refreshing marker on a failed refresh, and the next call says reconnect without refreshing', async () => {
    const f = fixture(800_000); await f.vault.set('ref', JSON.stringify(ready));
    f.refresh.mockRejectedValueOnce(new Error('boom'));
    await expect(f.run({ messages: { refreshFailed: 'Refresh failed.' } })).rejects.toThrow('Refresh failed.');
    expect(JSON.parse((await f.vault.get('ref'))!).state).toBe('refreshing');
    await expect(f.run({ messages: { interrupted: 'Reconnect it.' } })).rejects.toThrow('Reconnect it.');
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('spends nothing when the marker cannot be written, and uses nothing it could not save', async () => {
    const f = fixture(800_000); await f.vault.set('ref', JSON.stringify(ready));
    const set = vi.spyOn(f.vault, 'set').mockRejectedValueOnce(new Error('locked'));
    await expect(f.run()).rejects.toThrow('locked'); expect(f.refresh).not.toHaveBeenCalled();
    set.mockRestore();
    const original = f.vault.set.bind(f.vault);
    vi.spyOn(f.vault, 'set').mockImplementation(async (ref, value) => {
      if (JSON.parse(value).accessToken === 'a2') throw new Error('locked');
      return original(ref, value);
    });
    await expect(f.run()).rejects.toThrow('could not be saved');
  });
  it('says so when nothing is stored', async () => {
    await expect(fixture(0).run({ messages: { missing: 'Connect first.' } })).rejects.toThrow('Connect first.');
  });
});
