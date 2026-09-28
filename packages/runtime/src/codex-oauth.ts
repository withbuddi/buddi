/**
 * ChatGPT subscription sign-in: the device-code OAuth the Codex CLI uses,
 * done by buddi itself. No `codex` binary, no owner `~/.codex`.
 *
 * The flow differs from RFC 8628: the usercode call returns a
 * `device_auth_id`, polls are keyed by it (403/404 mean "not yet"), and an
 * approval returns an authorization code plus a server-made PKCE verifier,
 * which are exchanged at `/oauth/token` with the device redirect. Refresh
 * tokens rotate and are single use: the caller persists every rotated pair.
 *
 * Nothing here puts a response body, a token or a code into an error message.
 */
import { OAuthClient, readOAuthTokens, validOAuthId as validId, validToken, type OAuthTokens } from './oauth.js';
import { defaultHttpTransport, type HttpTransport } from './transport.js';

export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_DEVICE_REDIRECT = `${CODEX_ISSUER}/deviceauth/callback`;
export const CODEX_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
/** The server gives no expiry for a device code; the Codex CLI waits 15 minutes. */
export const CODEX_DEVICE_TIMEOUT_MS = 15 * 60_000;
const AUTH_CLAIM = 'https://api.openai.com/auth';

export interface CodexTokens {
  version: 1; state: 'ready' | 'refreshing';
  accessToken: string; refreshToken: string; idToken?: string;
  accountId: string; expiresAt: number;
}
export interface CodexDeviceStart {
  deviceAuthId: string; userCode: string; verificationUrl: string; intervalMs: number; expiresAt: number;
}
export type CodexDevicePoll = 'pending' | 'slow_down' | { code: string; verifier: string } | { denied: string };

const INVALID = 'Invalid ChatGPT credential. Reconnect this account.';

/** A JWT's payload, unverified: the claims are routing hints, the token itself is the credential. */
function jwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part || part.length > 16384) return null;
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export function codexAccountId(token: string | undefined): string | undefined {
  const auth = jwtPayload(token)?.[AUTH_CLAIM];
  const id = auth && typeof auth === 'object' ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  return validId(id) ? id : undefined;
}
/** Epoch ms from the `exp` claim, or 0 (treat as expired) when absent. */
export function codexTokenExpiry(token: string | undefined): number {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

/**
 * buddi's envelope, or the legacy vault value (Codex's own `auth.json`, as the
 * old runner stored it, possibly hex-encoded by macOS `security -w`),
 * converted to the envelope.
 */
export function readCodexTokens(raw: string): CodexTokens {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    let value = raw;
    if (/^(?:[0-9a-f]{2})+$/i.test(value)) value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'hex'));
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error();
    const data = JSON.parse(value) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    if (data.version === 1) return toCodex(readOAuthTokens(value, { invalidMessage: INVALID, requireRefreshToken: true, requireAccountId: true, keep: ['idToken'] }));
    const tokens = data.tokens as Record<string, unknown> | undefined;
    if (!tokens || typeof tokens !== 'object' || data.OPENAI_API_KEY ||
      (data.auth_mode !== undefined && data.auth_mode !== 'chatgpt') ||
      !validToken(tokens.access_token) || !validToken(tokens.refresh_token) ||
      (tokens.id_token !== undefined && tokens.id_token !== null && !validToken(tokens.id_token))) throw new Error();
    const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : undefined;
    const accountId = validId(tokens.account_id) ? tokens.account_id : codexAccountId(tokens.access_token) ?? codexAccountId(idToken);
    if (!accountId) throw new Error();
    return { version: 1, state: 'ready', accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      ...(idToken ? { idToken } : {}), accountId, expiresAt: codexTokenExpiry(tokens.access_token) };
  } catch { throw new Error(INVALID); }
}

/** The envelope as Codex's `auth.json`, for a staged private profile. */
export function codexAuthJson(tokens: CodexTokens, now = Date.now): string {
  return JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: tokens.idToken ?? null, access_token: tokens.accessToken, refresh_token: tokens.refreshToken, account_id: tokens.accountId },
    last_refresh: new Date(now()).toISOString(),
  });
}

/** The shared envelope, as the Codex shape: the id token rides in `extra`. */
function toCodex(t: OAuthTokens): CodexTokens {
  const idToken = t.extra?.idToken;
  return { version: 1, state: t.state, accessToken: t.accessToken, refreshToken: t.refreshToken!,
    ...(idToken ? { idToken } : {}), accountId: t.accountId!, expiresAt: t.expiresAt };
}
function fromCodex(t: CodexTokens): OAuthTokens {
  return { version: 1, state: t.state, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt,
    accountId: t.accountId, ...(t.idToken ? { extra: { idToken: t.idToken } } : {}) };
}

export class CodexOAuthProtocol {
  readonly #client: OAuthClient;
  constructor(readonly transport: HttpTransport = defaultHttpTransport, readonly now = Date.now) {
    this.#client = new OAuthClient({
      tokenEndpoint: TOKEN_URL, clientId: CODEX_CLIENT_ID, format: 'form', transport, now,
      requireRefreshToken: true,
      expiryFallback: (data) => codexTokenExpiry(data.access_token as string),
      messages: { exchange: 'ChatGPT sign-in could not complete. Start a fresh sign-in.', refresh: 'ChatGPT token refresh failed. Reconnect this account.' },
      finish: (tokens, data, previous) => {
        const idToken = validToken(data.id_token) ? data.id_token : previous?.extra?.idToken;
        const accountId = codexAccountId(tokens.accessToken) ?? codexAccountId(idToken) ?? previous?.accountId;
        if (!accountId) throw new Error();
        const { scopes: _scopes, clientId: _clientId, ...rest } = tokens;
        return { ...rest, accountId, ...(idToken ? { extra: { idToken } } : {}) };
      },
    });
  }

  async #post(url: string, body: string, type: 'json' | 'form') {
    return this.transport(url, {
      method: 'POST',
      headers: { 'content-type': type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json' },
      body, signal: AbortSignal.timeout(20_000), maxBytes: 65536,
    });
  }

  async startDevice(): Promise<CodexDeviceStart> {
    let res;
    try { res = await this.#post(USERCODE_URL, JSON.stringify({ client_id: CODEX_CLIENT_ID }), 'json'); }
    catch { throw new Error('Could not reach ChatGPT sign-in. Check the network and try again.'); }
    if (res.status === 404) throw new Error('Device code sign-in is not enabled on this ChatGPT account. Turn it on in ChatGPT settings, under Security.');
    try {
      if (!res.ok) throw new Error();
      const data = await res.json() as Record<string, unknown>;
      const userCode = data.user_code ?? data.usercode;
      if (!validId(data.device_auth_id) || typeof userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)) throw new Error();
      const interval = typeof data.interval === 'string' ? Number(data.interval.trim()) : data.interval;
      const seconds = typeof interval === 'number' && Number.isFinite(interval) && interval > 0 && interval <= 60 ? interval : 5;
      return { deviceAuthId: data.device_auth_id, userCode, verificationUrl: CODEX_VERIFY_URL,
        intervalMs: seconds * 1000, expiresAt: this.now() + CODEX_DEVICE_TIMEOUT_MS };
    } catch { throw new Error('ChatGPT sign-in could not start. Try again in a moment.'); }
  }

  async pollDevice(deviceAuthId: string, userCode: string): Promise<CodexDevicePoll> {
    let res;
    try { res = await this.#post(DEVICE_TOKEN_URL, JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }), 'json'); }
    catch { return 'pending'; } // A network blip is not a denial; the deadline still bounds the wait.
    if (res.ok) {
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (data && validToken(data.authorization_code) && validToken(data.code_verifier)) return { code: data.authorization_code, verifier: data.code_verifier };
      return { denied: 'ChatGPT sent an unexpected sign-in response. Start again.' };
    }
    if (res.status === 403 || res.status === 404) return 'pending';
    let code: unknown;
    try {
      const error = (JSON.parse(await res.text()) as { error?: unknown }).error;
      code = error && typeof error === 'object' ? (error as { code?: unknown }).code : error;
    } catch { /* not JSON */ }
    if (code === 'deviceauth_authorization_pending' || code === 'authorization_pending') return 'pending';
    if (code === 'slow_down') return 'slow_down';
    if (res.status === 429) return 'slow_down';
    return { denied: code === 'access_denied' || code === 'expired_token' ? 'Sign-in was declined or expired on ChatGPT. Start again.' : 'ChatGPT did not approve the sign-in. Start again.' };
  }

  async exchange(input: { code: string; verifier: string }): Promise<CodexTokens> {
    return toCodex(await this.#client.exchangeCode({ code: input.code, verifier: input.verifier, redirectUri: CODEX_DEVICE_REDIRECT }));
  }

  async refresh(tokens: CodexTokens): Promise<CodexTokens> {
    return toCodex(await this.#client.refresh(fromCodex(tokens), { scope: 'openid profile email' }));
  }
}
