import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { defaultHttpTransport, type HttpTransport } from './transport.js';

// Isolated protocol constants, matching the existing Vonzio/extension flow.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export interface AnthropicTokens {
  version: 1; state: 'ready' | 'refreshing';
  accessToken: string; refreshToken: string; expiresAt: number; scopes: string[];
}
export function createAnthropicLogin() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ code: 'true', client_id: CLIENT_ID, response_type: 'code',
    redirect_uri: REDIRECT, scope: 'user:inference', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), state });
  return { verifier, state, authorizeUrl: `https://claude.com/cai/oauth/authorize?${query.toString().replaceAll('+', '%20')}` };
}
export function parseAnthropicCode(input: string, expectedState: string): { code: string; state: string } {
  if (!input || input.length > 8192) throw new Error('Paste the full authorization code, including #state.');
  let code: string | null | undefined; let state: string | null | undefined;
  const value = input.trim();
  if (value.startsWith('https://')) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Invalid authorization callback. Start sign-in again.'); }
    if (url.origin + url.pathname !== REDIRECT) throw new Error('Unexpected authorization callback. Start sign-in again.');
    code = url.searchParams.get('code'); state = url.searchParams.get('state');
  } else {
    const parts = value.split('#');
    if (parts.length !== 2) throw new Error('Paste the full authorization code, including #state.');
    [code, state] = parts.map(s => s.trim());
  }
  if (!code || !state || /\s/.test(code) || Buffer.byteLength(state) !== Buffer.byteLength(expectedState) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) throw new Error('Paste the full code from this sign-in. Authorization state did not match.');
  return { code, state };
}
export function readAnthropicTokens(value: string): AnthropicTokens {
  try {
    if (value.length > 65536) throw new Error();
    const data = JSON.parse(value) as AnthropicTokens;
    if (data.version !== 1 || !['ready', 'refreshing'].includes(data.state) ||
      !validToken(data.accessToken) || !validToken(data.refreshToken) ||
      !Number.isFinite(data.expiresAt) || data.expiresAt <= 0 || !Array.isArray(data.scopes) ||
      !data.scopes.every(s => typeof s === 'string' && s.length <= 200)) throw new Error();
    return data;
  } catch { throw new Error('Invalid Claude credential. Reconnect this account.'); }
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value);
}
export class AnthropicOAuthProtocol {
  constructor(readonly transport: HttpTransport = defaultHttpTransport, readonly now = Date.now) {}
  async #token(body: Record<string, string>, scopes: string[]): Promise<AnthropicTokens> {
    try {
      const res = await this.transport(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, ...body }), signal: AbortSignal.timeout(20_000), maxBytes: 65536 });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!validToken(data?.access_token) || !validToken(data?.refresh_token) ||
        typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 366 * 86400) throw new Error();
      const granted = data.scope === undefined ? scopes : typeof data.scope === 'string' && data.scope.length < 4096 ? data.scope.split(/\s+/).filter(Boolean) : [];
      if (!granted.includes('user:inference')) throw new Error();
      return { version: 1, state: 'ready', accessToken: data.access_token, refreshToken: data.refresh_token,
        expiresAt: this.now() + data.expires_in * 1000, scopes: granted };
    } catch { throw new Error('Claude authorization could not complete. Start a fresh sign-in; no automatic retry was sent.'); }
  }
  exchange(input: { code: string; state: string; verifier: string }) {
    return this.#token({ grant_type: 'authorization_code', code: input.code, state: input.state,
      code_verifier: input.verifier, redirect_uri: REDIRECT }, ['user:inference']);
  }
  refresh(tokens: AnthropicTokens) {
    return this.#token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens.scopes);
  }
}
