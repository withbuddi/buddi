/**
 * Claude subscription sign-in: PKCE with a pasted `code#state`, on the shared
 * OAuth module (`oauth.ts`). The stored envelope is `OAuthTokens` with a
 * refresh token and scopes always present, which is what `AnthropicTokens`
 * names.
 */
import { authorizeUrl, OAuthCallbackError, OAuthClient, oauthState, parseCallback, pkcePair, readOAuthTokens, type OAuthTokens } from './oauth.js';
import { defaultHttpTransport, type HttpTransport } from './transport.js';

// Isolated protocol constants, matching the existing Vonzio/extension flow.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const SCOPE = 'user:inference';
const FAILED = 'Claude authorization could not complete. Start a fresh sign-in; no automatic retry was sent.';

export interface AnthropicTokens {
  version: 1; state: 'ready' | 'refreshing';
  accessToken: string; refreshToken: string; expiresAt: number; scopes: string[];
}
export function createAnthropicLogin() {
  const { verifier, challenge } = pkcePair();
  const state = oauthState();
  return { verifier, state, authorizeUrl: authorizeUrl({ authorizationEndpoint: AUTHORIZE_URL, clientId: CLIENT_ID,
    redirectUri: REDIRECT, scopes: [SCOPE], state, challenge, extra: { code: 'true' } }) };
}
export function parseAnthropicCode(input: string, expectedState: string): { code: string; state: string } {
  if (!input || input.length > 8192) throw new Error('Paste the full authorization code, including #state.');
  try {
    return parseCallback(input, expectedState, { redirectUri: REDIRECT, allowCodeHashState: true });
  } catch (error) {
    const reason = error instanceof OAuthCallbackError ? error.reason : 'malformed';
    if (reason === 'foreign') throw new Error('Unexpected authorization callback. Start sign-in again.');
    if (reason === 'state' || reason === 'denied') throw new Error('Paste the full code from this sign-in. Authorization state did not match.');
    if (/^https?:\/\//.test(input.trim())) throw new Error('Invalid authorization callback. Start sign-in again.');
    throw new Error('Paste the full authorization code, including #state.');
  }
}
function toAnthropic(t: OAuthTokens): AnthropicTokens {
  return { version: 1, state: t.state, accessToken: t.accessToken, refreshToken: t.refreshToken!, expiresAt: t.expiresAt, scopes: t.scopes ?? [] };
}
export function readAnthropicTokens(value: string): AnthropicTokens {
  return toAnthropic(readOAuthTokens(value, { invalidMessage: 'Invalid Claude credential. Reconnect this account.',
    requireRefreshToken: true, requireScopes: true, requirePositiveExpiry: true }));
}
export class AnthropicOAuthProtocol {
  readonly #client: OAuthClient;
  constructor(readonly transport: HttpTransport = defaultHttpTransport, readonly now = Date.now) {
    this.#client = new OAuthClient({ tokenEndpoint: TOKEN_URL, clientId: CLIENT_ID, format: 'json', transport, now,
      requireRefreshToken: true, requireExpiry: true, requiredScopes: [SCOPE], messages: { exchange: FAILED, refresh: FAILED } });
  }
  async exchange(input: { code: string; state: string; verifier: string }): Promise<AnthropicTokens> {
    return toAnthropic(await this.#client.exchangeCode({ code: input.code, state: input.state, verifier: input.verifier,
      redirectUri: REDIRECT, scopes: [SCOPE] }));
  }
  async refresh(tokens: AnthropicTokens): Promise<AnthropicTokens> {
    return toAnthropic(await this.#client.refresh(tokens));
  }
}
