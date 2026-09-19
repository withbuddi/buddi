import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AnthropicOAuthProtocol, createAnthropicLogin, parseAnthropicCode, readAnthropicTokens } from './anthropic-oauth.js';
import type { HttpTransport } from './transport.js';

it('uses distinct random state and PKCE S256; the verifier never enters the URL', () => {
  const p = createAnthropicLogin(); const url = new URL(p.authorizeUrl);
  expect(url.origin).toBe('https://claude.com');
  expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
  expect(url.searchParams.get('scope')).toBe('user:inference');
  expect(p.state).not.toBe(p.verifier); expect(p.authorizeUrl).not.toContain(p.verifier);
  expect(createAnthropicLogin().state).not.toBe(p.state);
});
it('requires the complete state and rejects foreign callbacks and malformed pastes', () => {
  expect(parseAnthropicCode(' abc # state ', 'state')).toEqual({ code: 'abc', state: 'state' });
  expect(parseAnthropicCode('https://platform.claude.com/oauth/code/callback?code=abc&state=state', 'state').code).toBe('abc');
  for (const input of ['abc', 'abc#wrong', 'abc#state#extra', 'https://evil.example?code=abc&state=state', 'x'.repeat(8193)]) {
    expect(() => parseAnthropicCode(input, 'state')).toThrow();
  }
});
function transport(data: unknown, status = 200) {
  return vi.fn<HttpTransport>().mockResolvedValue({ ok: status === 200, status, statusText: '', headers: { get: () => null },
    json: async () => data, text: async () => 'SECRET RESPONSE', arrayBuffer: async () => new ArrayBuffer(0) });
}
const response = { access_token: 'access-fixture', refresh_token: 'refresh-fixture', expires_in: 3600, scope: 'user:inference' };
it('exchanges once on the shared bounded transport and records actual expiry', async () => {
  const send = transport(response); const client = new AnthropicOAuthProtocol(send, () => 1000);
  const tokens = await client.exchange({ code: 'code-fixture', state: 'state-fixture', verifier: 'verifier-fixture' });
  expect(tokens.expiresAt).toBe(3601000);
  expect(readAnthropicTokens(JSON.stringify(tokens))).toEqual(tokens);
  const [url, options] = send.mock.calls[0]!;
  expect(url).toBe('https://platform.claude.com/v1/oauth/token');
  expect(options.maxBytes).toBe(65536); expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(options.body as string)).toMatchObject({ code_verifier: 'verifier-fixture', grant_type: 'authorization_code' });
  await client.refresh(tokens);
  expect(JSON.parse(send.mock.calls[1]![1].body as string)).toMatchObject({ refresh_token: 'refresh-fixture', grant_type: 'refresh_token' });
});
it.each([{}, { ...response, expires_in: undefined }, { ...response, expires_in: -1 }, { ...response, scope: 'profile' }, { ...response, refresh_token: '' }])('rejects malformed credentials without fabricated expiry or raw data', async value => {
  const client = new AnthropicOAuthProtocol(transport(value));
  await expect(client.exchange({ code: 'secret', state: 'x', verifier: 'v' })).rejects.toThrow('fresh sign-in');
});
it('redacts transport errors and never retries token exchange', async () => {
  const send = transport({}, 429); const client = new AnthropicOAuthProtocol(send);
  await expect(client.exchange({ code: 'secret', state: 'x', verifier: 'v' })).rejects.toThrow('no automatic retry');
  expect(send).toHaveBeenCalledTimes(1);
  send.mockRejectedValue(new Error('SECRET RESPONSE'));
  await expect(client.exchange({ code: 'secret', state: 'x', verifier: 'v' })).rejects.not.toThrow('SECRET');
});
