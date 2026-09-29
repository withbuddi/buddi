/**
 * The OAuth device flow (RFC 8628) for a connection (docs/connections.md,
 * "Connect"): ask the service for a code, the owner types it on the service's
 * site, buddi polls the token endpoint until the owner says yes.
 *
 * The shape is the ChatGPT sign-in's (`@buddi/runtime`'s codex-oauth.ts): the
 * server's interval is honoured, `slow_down` adds to it, `authorization_pending`
 * waits, `expired_token` and `access_denied` end it. GitHub answers its errors
 * with a 200 and an `error` field; RFC 8628 says 400: both are read the same.
 *
 * Nothing here puts a response body, a code or a token into an error message.
 */
import type { HttpTransport, OAuthTokens } from './ports.js';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** A service that names no expiry: fifteen minutes, as GitHub's own. */
const DEFAULT_EXPIRES_S = 15 * 60;
const MAX_LIFETIME_S = 366 * 86400;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Epoch ms. */
  expiresAt: number;
  intervalMs: number;
}

export type DevicePoll =
  | { kind: 'pending' }
  | { kind: 'slow_down'; intervalMs?: number }
  | { kind: 'tokens'; tokens: OAuthTokens }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'failed' };

const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const validToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v);

async function post(transport: HttpTransport, url: string, params: Record<string, string>) {
  return transport(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
    maxBytes: 65536,
  });
}

function seconds(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Ask for a device code. Throws a sentence naming `service`, never the answer. */
export async function startDevice(
  transport: HttpTransport,
  input: { deviceEndpoint: string; clientId: string; scopes: readonly string[]; service: string; now: number },
): Promise<DeviceStart> {
  let res;
  try {
    res = await post(transport, input.deviceEndpoint, { client_id: input.clientId, ...(input.scopes.length > 0 ? { scope: input.scopes.join(' ') } : {}) });
  } catch {
    throw new Error(`buddi could not reach ${input.service} to start the sign-in. Check the network and try again.`);
  }
  try {
    if (!res.ok) throw new Error();
    const data = await res.json() as Record<string, unknown>;
    if (!data || typeof data !== 'object' || data.error !== undefined) throw new Error();
    const uri = data.verification_uri ?? data.verification_url;
    if (!validToken(data.device_code) || typeof data.user_code !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(data.user_code)) throw new Error();
    if (typeof uri !== 'string' || !/^https:\/\/[^\s]+$/.test(uri) || uri.length > 512) throw new Error();
    const interval = Math.min(seconds(data.interval) ?? 5, 60);
    const expires = Math.min(seconds(data.expires_in) ?? DEFAULT_EXPIRES_S, 60 * 60);
    return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: uri, expiresAt: input.now + expires * 1000, intervalMs: interval * 1000 };
  } catch {
    throw new Error(`${input.service} did not start the sign-in. Try again in a moment.`);
  }
}

/** One poll of the token endpoint. A network blip is "not yet": the deadline still bounds the wait. */
export async function pollDevice(
  transport: HttpTransport,
  input: { tokenEndpoint: string; clientId: string; deviceCode: string; now: number },
): Promise<DevicePoll> {
  let res;
  try {
    res = await post(transport, input.tokenEndpoint, { client_id: input.clientId, device_code: input.deviceCode, grant_type: DEVICE_GRANT });
  } catch {
    return { kind: 'pending' };
  }
  let data: Record<string, unknown> | null = null;
  try { data = await res.json() as Record<string, unknown>; } catch { /* not JSON */ }
  if (!data || typeof data !== 'object') return res.status === 429 ? { kind: 'slow_down' } : res.status >= 500 ? { kind: 'pending' } : { kind: 'failed' };
  const error = data.error;
  if (error === 'authorization_pending') return { kind: 'pending' };
  if (error === 'slow_down') {
    const interval = seconds(data.interval);
    return interval ? { kind: 'slow_down', intervalMs: Math.min(interval, 120) * 1000 } : { kind: 'slow_down' };
  }
  if (error === 'expired_token') return { kind: 'expired' };
  if (error === 'access_denied') return { kind: 'denied' };
  if (error !== undefined || !res.ok) return res.status >= 500 ? { kind: 'pending' } : { kind: 'failed' };
  if (!validToken(data.access_token)) return { kind: 'failed' };
  if (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) return { kind: 'failed' };
  const refreshToken = data.refresh_token === undefined || data.refresh_token === null || data.refresh_token === '' ? undefined : data.refresh_token;
  if (refreshToken !== undefined && !validToken(refreshToken)) return { kind: 'failed' };
  const expiresIn = seconds(data.expires_in);
  const expiresAt = expiresIn !== undefined && expiresIn <= MAX_LIFETIME_S
    ? input.now + expiresIn * 1000
    : input.now + (refreshToken ? 3600_000 : 365 * 86400_000);
  const scopes = typeof data.scope === 'string' && data.scope.length < 4096 ? data.scope.split(/[\s,]+/).filter(Boolean) : undefined;
  return {
    kind: 'tokens',
    tokens: {
      version: 1, state: 'ready', accessToken: data.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt,
      ...(scopes ? { scopes } : {}),
      clientId: input.clientId,
    },
  };
}
