/**
 * OAuth 2.1 pieces every sign-in in buddi shares: the Claude and ChatGPT
 * subscription sign-ins today, remote MCP connections next
 * (buddi-planning/specs/mcp-client.md §4).
 *
 * - The vault envelope (`OAuthTokens`) and its reader.
 * - PKCE (S256), the authorize URL and the callback parser.
 * - Discovery: the MCP authorization spec's protected-resource metadata
 *   (RFC 9728), then the authorization server's metadata (RFC 8414 / OIDC).
 * - Dynamic client registration (RFC 7591), public client, no secret.
 * - `OAuthClient`: the code exchange and the refresh at a token endpoint.
 * - `refreshDiscipline`: the ready / refreshing / reconnect dance, once.
 *
 * Nothing here puts a response body, a token or a code into an error message,
 * and nothing retries a token request on its own: a refresh token may be
 * single use, and a blind retry of one that reached the server burns it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Vault } from '@buddi/core';
import { defaultHttpTransport, type HttpTransport, type TransportResponse } from './transport.js';

/* ------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------ */

/**
 * What one vault entry holds for one OAuth sign-in. `state: 'refreshing'` is
 * the durable marker written before a refresh token is spent: an entry found in
 * that state means a refresh may have been consumed and its answer lost, so the
 * only safe move is a new sign-in, never a replay.
 */
export interface OAuthTokens {
  version: 1;
  state: 'ready' | 'refreshing';
  accessToken: string;
  /** Absent when the server gave none: connected until `expiresAt`, then reconnect. */
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes?: string[];
  /** The client id the tokens were issued to (a registered client, for MCP). */
  clientId?: string;
  /** The resource (RFC 8707) the tokens are for: an MCP server's address. */
  resource?: string;
  /** A provider's account id, when the tokens name one (ChatGPT). */
  accountId?: string;
  /** Small provider-specific strings kept with the tokens (an id token). */
  extra?: Record<string, string>;
}

export interface ReadOAuthTokensOptions {
  /** The sentence thrown for anything unreadable. */
  invalidMessage?: string;
  requireRefreshToken?: boolean;
  requireScopes?: boolean;
  requireAccountId?: boolean;
  /** `expiresAt` must be > 0 (a stored 0 otherwise reads "expired, refresh"). */
  requirePositiveExpiry?: boolean;
  /**
   * Stored envelopes of an older shape, converted before validation: return
   * the envelope, or undefined when `data` is not that shape.
   */
  adapt?: (data: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** Top-level token-shaped fields of a caller's own envelope kept verbatim in `extra`. */
  keep?: readonly string[];
}

const MAX_ENVELOPE_BYTES = 64 * 1024;

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value);
}
export function validOAuthId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}
function validScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 200 && value.every((s) => typeof s === 'string' && s.length <= 200);
}

/** Parse and check a stored envelope. Throws `invalidMessage`, never the value. */
export function readOAuthTokens(raw: string, opts: ReadOAuthTokensOptions = {}): OAuthTokens {
  const invalid = opts.invalidMessage ?? 'Invalid sign-in credential. Reconnect this account.';
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_ENVELOPE_BYTES) throw new Error();
    let data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    if (data.version !== 1 && opts.adapt) data = opts.adapt(data) ?? data;
    const t = data as Partial<OAuthTokens> & Record<string, unknown>;
    if (t.version !== 1 || (t.state !== 'ready' && t.state !== 'refreshing') || !validToken(t.accessToken)) throw new Error();
    if (t.refreshToken !== undefined ? !validToken(t.refreshToken) : opts.requireRefreshToken) throw new Error();
    if (typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt) || t.expiresAt < 0) throw new Error();
    if (opts.requirePositiveExpiry && t.expiresAt <= 0) throw new Error();
    if (t.scopes !== undefined ? !validScopes(t.scopes) : opts.requireScopes) throw new Error();
    if (t.clientId !== undefined && !validOAuthId(t.clientId) && !validToken(t.clientId)) throw new Error();
    if (t.resource !== undefined && (typeof t.resource !== 'string' || t.resource.length > 2048)) throw new Error();
    if (t.accountId !== undefined ? !validOAuthId(t.accountId) : opts.requireAccountId) throw new Error();
    const extra: Record<string, string> = {};
    if (t.extra !== undefined) {
      if (!t.extra || typeof t.extra !== 'object' || Array.isArray(t.extra)) throw new Error();
      for (const [key, value] of Object.entries(t.extra)) {
        if (typeof value !== 'string' || value.length > 16384 || key.length > 64) throw new Error();
        extra[key] = value;
      }
    }
    for (const key of opts.keep ?? []) {
      if (t[key] === undefined) continue;
      if (!validToken(t[key])) throw new Error();
      extra[key] = t[key] as string;
    }
    return {
      version: 1, state: t.state, accessToken: t.accessToken,
      ...(t.refreshToken !== undefined ? { refreshToken: t.refreshToken } : {}),
      expiresAt: t.expiresAt,
      ...(t.scopes !== undefined ? { scopes: [...t.scopes] } : {}),
      ...(t.clientId !== undefined ? { clientId: t.clientId } : {}),
      ...(t.resource !== undefined ? { resource: t.resource } : {}),
      ...(t.accountId !== undefined ? { accountId: t.accountId } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
  } catch { throw new Error(invalid); }
}

/* ------------------------------------------------------------------ *
 * PKCE, the authorize URL, the callback
 * ------------------------------------------------------------------ */

export interface PkcePair { verifier: string; challenge: string; method: 'S256' }

/** A fresh verifier and its S256 challenge. The verifier never enters a URL. */
export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), method: 'S256' };
}

/** A fresh, unguessable `state`. */
export function oauthState(): string {
  return randomBytes(32).toString('base64url');
}

export interface AuthorizeUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
  /** RFC 8707: the MCP server the token is for. */
  resource?: string;
  /** Provider-specific parameters, placed first (Claude's `code=true`). */
  extra?: Record<string, string>;
}

export function authorizeUrl(p: AuthorizeUrlParams): string {
  const query = new URLSearchParams({
    ...(p.extra ?? {}),
    client_id: p.clientId, response_type: 'code', redirect_uri: p.redirectUri,
    ...(p.scopes && p.scopes.length > 0 ? { scope: p.scopes.join(' ') } : {}),
    code_challenge_method: 'S256', code_challenge: p.challenge, state: p.state,
    ...(p.resource ? { resource: p.resource } : {}),
  });
  const url = new URL(p.authorizationEndpoint);
  for (const [key, value] of url.searchParams) if (!query.has(key)) query.append(key, value);
  return `${url.origin}${url.pathname}?${query.toString().replaceAll('+', '%20')}`;
}

export type OAuthCallbackProblem = 'malformed' | 'foreign' | 'state' | 'denied';

/** Why a callback was refused. `reason` lets a caller say it in its own words. */
export class OAuthCallbackError extends Error {
  constructor(readonly reason: OAuthCallbackProblem, message: string) { super(message); this.name = 'OAuthCallbackError'; }
}

export interface ParseCallbackOptions {
  /** A full URL must have this origin + path. Absent: any https URL (or loopback http). */
  redirectUri?: string;
  /** Accept a pasted `code#state` (Claude's code page). */
  allowCodeHashState?: boolean;
}

/**
 * The code from a redirect URL, or a pasted `code#state`, checked against the
 * state this sign-in sent in constant time. Throws `OAuthCallbackError`.
 */
export function parseCallback(input: string | URL, expectedState: string, opts: ParseCallbackOptions = {}): { code: string; state: string } {
  const text = typeof input === 'string' ? input.trim() : input.toString();
  if (!text || text.length > 8192) throw new OAuthCallbackError('malformed', 'The sign-in answer is missing or too long.');
  let code: string | null | undefined;
  let state: string | null | undefined;
  if (typeof input !== 'string' || /^https?:\/\//.test(text)) {
    let url: URL;
    try { url = typeof input === 'string' ? new URL(text) : input; } catch { throw new OAuthCallbackError('malformed', 'Invalid sign-in callback.'); }
    if (opts.redirectUri !== undefined) {
      const expected = new URL(opts.redirectUri);
      if (url.origin + url.pathname !== expected.origin + expected.pathname) throw new OAuthCallbackError('foreign', 'Unexpected sign-in callback.');
    } else if (url.protocol !== 'https:' && !isLoopback(url)) {
      throw new OAuthCallbackError('foreign', 'Unexpected sign-in callback.');
    }
    state = url.searchParams.get('state');
    if (url.searchParams.get('error')) {
      if (!sameState(state, expectedState)) throw new OAuthCallbackError('state', 'Authorization state did not match.');
      throw new OAuthCallbackError('denied', 'The sign-in was declined.');
    }
    code = url.searchParams.get('code');
  } else {
    if (!opts.allowCodeHashState) throw new OAuthCallbackError('malformed', 'Invalid sign-in callback.');
    const parts = text.split('#');
    if (parts.length !== 2) throw new OAuthCallbackError('malformed', 'Paste the full code, including #state.');
    [code, state] = parts.map((s) => s.trim());
  }
  if (!code || /\s/.test(code) || code.length > 4096) throw new OAuthCallbackError('malformed', 'The sign-in answer has no code.');
  if (!sameState(state, expectedState)) throw new OAuthCallbackError('state', 'Authorization state did not match.');
  return { code, state: state as string };
}

function sameState(state: string | null | undefined, expected: string): boolean {
  if (!state || Buffer.byteLength(state) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(state), Buffer.from(expected));
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethods?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethods?: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported?: string[];
}

export interface DiscoveredAuthorization {
  /** The canonical resource to name in `resource=` (the protected resource's own, when it said). */
  resource: string;
  /** Undefined when the server published none (the pre-2025-06 MCP fallback was used). */
  protectedResource?: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  /** The scopes to ask for: the challenge's, else the resource's, else none. */
  scopes: string[];
}

/** A `WWW-Authenticate` header, read: scheme and its auth-params. */
export function parseWwwAuthenticate(header: string | null | undefined): { scheme: string; params: Record<string, string> } | undefined {
  if (!header || header.length > 8192) return undefined;
  const match = /^\s*([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s*(.*)$/s.exec(header);
  if (!match) return undefined;
  const params: Record<string, string> = {};
  const re = /([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))\s*,?\s*/gy;
  const rest = match[2] ?? '';
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (re.lastIndex < rest.length && (m = re.exec(rest)) !== null) {
    params[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '');
  }
  return { scheme: match[1]!.toLowerCase(), params };
}

export interface DiscoverOptions {
  transport?: HttpTransport;
  /** The `WWW-Authenticate` of a 401 from the resource, when there was one. */
  wwwAuthenticate?: string | null;
  /** Allow `http:` for loopback addresses (tests, a local server). Off by default. */
  allowLoopbackHttp?: boolean;
}

const DISCOVERY_MAX_BYTES = 256 * 1024;

/**
 * How to sign in to `resourceUrl` (an MCP server's address), per the MCP
 * authorization spec: the resource metadata a 401 named, or the well-known
 * one at the resource (path-aware, then root); then the named authorization
 * server's metadata, RFC 8414 first, OpenID Connect discovery second. A server
 * that publishes no resource metadata is taken to be its own authorization
 * server (the MCP 2025-03-26 fallback). Every URL must be https; nothing
 * follows a redirect.
 */
export async function discoverAuthorization(resourceUrl: string, opts: DiscoverOptions = {}): Promise<DiscoveredAuthorization> {
  const transport = opts.transport ?? defaultHttpTransport;
  const loopback = opts.allowLoopbackHttp === true;
  const resource = safeUrl(resourceUrl, loopback, 'The server address must be an https address.');
  const challenge = parseWwwAuthenticate(opts.wwwAuthenticate);
  const challengeScopes = challenge?.scheme === 'bearer' && challenge.params.scope ? splitScopes(challenge.params.scope) : undefined;

  const candidates: string[] = [];
  const named = challenge?.scheme === 'bearer' ? challenge.params.resource_metadata : undefined;
  if (named) candidates.push(safeUrl(named, loopback, 'The server named a metadata address that is not https.').toString());
  const path = resource.pathname.replace(/\/$/, '');
  if (path) candidates.push(`${resource.origin}/.well-known/oauth-protected-resource${path}`);
  candidates.push(`${resource.origin}/.well-known/oauth-protected-resource`);

  let protectedResource: ProtectedResourceMetadata | undefined;
  for (const url of candidates) {
    const data = await getJson(transport, url);
    if (data === undefined) continue;
    protectedResource = readProtectedResource(data, resource, loopback);
    break;
  }

  const issuer = protectedResource
    ? safeUrl(protectedResource.authorizationServers[0]!, loopback, 'The authorization server address is not https.')
    : new URL(resource.origin);
  const authorizationServer = await discoverAuthorizationServer(issuer.toString(), { transport, allowLoopbackHttp: loopback });
  return {
    resource: protectedResource?.resource ?? canonicalResource(resource),
    ...(protectedResource ? { protectedResource } : {}),
    authorizationServer,
    scopes: challengeScopes ?? protectedResource?.scopesSupported ?? [],
  };
}

/** RFC 8414 metadata for an issuer, with the OIDC discovery fallbacks. */
export async function discoverAuthorizationServer(issuerUrl: string, opts: Omit<DiscoverOptions, 'wwwAuthenticate'> = {}): Promise<AuthorizationServerMetadata> {
  const transport = opts.transport ?? defaultHttpTransport;
  const loopback = opts.allowLoopbackHttp === true;
  const issuer = safeUrl(issuerUrl, loopback, 'The authorization server address is not https.');
  const path = issuer.pathname.replace(/\/$/, '');
  const candidates = path
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  for (const url of candidates) {
    const data = await getJson(transport, url);
    if (data === undefined) continue;
    return readAuthorizationServer(data, issuer, loopback);
  }
  throw new Error('The server did not say how to sign in to it (no authorization server metadata).');
}

function readProtectedResource(data: Record<string, unknown>, resource: URL, loopback: boolean): ProtectedResourceMetadata {
  const servers = data.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0 || !servers.every((s) => typeof s === 'string' && s.length <= 2048)) {
    throw new Error('The server\'s sign-in metadata names no authorization server.');
  }
  let named = canonicalResource(resource);
  if (data.resource !== undefined) {
    if (typeof data.resource !== 'string') throw new Error('The server\'s sign-in metadata is malformed.');
    const declared = safeUrl(data.resource, loopback, 'The server\'s sign-in metadata is malformed.');
    // RFC 9728 §3.3: the metadata must be about the resource that was asked.
    if (declared.origin !== resource.origin) throw new Error('The server\'s sign-in metadata is for another address.');
    named = data.resource;
  }
  const scopes = strings(data.scopes_supported);
  return { resource: named, authorizationServers: servers as string[], ...(scopes ? { scopesSupported: scopes } : {}) };
}

function readAuthorizationServer(data: Record<string, unknown>, issuer: URL, loopback: boolean): AuthorizationServerMetadata {
  const bad = 'The authorization server\'s metadata is malformed.';
  if (typeof data.issuer !== 'string' || stripSlash(data.issuer) !== stripSlash(issuer.toString())) {
    throw new Error('The authorization server\'s metadata names another issuer.');
  }
  if (typeof data.authorization_endpoint !== 'string' || typeof data.token_endpoint !== 'string') throw new Error(bad);
  const methods = strings(data.code_challenge_methods_supported);
  // MCP authorization: PKCE S256 is required, and a server that does not say
  // it supports it is refused rather than tried.
  if (!methods || !methods.includes('S256')) throw new Error('The authorization server does not support PKCE (S256), which buddi requires.');
  const registration = data.registration_endpoint;
  const scopes = strings(data.scopes_supported);
  const grants = strings(data.grant_types_supported);
  const auths = strings(data.token_endpoint_auth_methods_supported);
  return {
    issuer: data.issuer,
    authorizationEndpoint: safeUrl(data.authorization_endpoint, loopback, bad).toString(),
    tokenEndpoint: safeUrl(data.token_endpoint, loopback, bad).toString(),
    ...(typeof registration === 'string' ? { registrationEndpoint: safeUrl(registration, loopback, bad).toString() } : {}),
    ...(scopes ? { scopesSupported: scopes } : {}),
    codeChallengeMethods: methods,
    ...(grants ? { grantTypesSupported: grants } : {}),
    ...(auths ? { tokenEndpointAuthMethods: auths } : {}),
  };
}

async function getJson(transport: HttpTransport, url: string): Promise<Record<string, unknown> | undefined> {
  let res: TransportResponse;
  try {
    res = await transport(url, { method: 'GET', headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' },
      signal: AbortSignal.timeout(15_000), maxBytes: DISCOVERY_MAX_BYTES });
  } catch { throw new Error('Could not reach the server to read how it signs in. Check the address and the network.'); }
  if (res.status === 404 || res.status === 405 || res.status === 400 || res.status === 401 || res.status === 403) return undefined;
  if (!res.ok) throw new Error(`The server answered ${res.status} while buddi read how it signs in.`);
  try {
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new Error('The server\'s sign-in metadata is not JSON.'); }
}

function safeUrl(text: string, loopback: boolean, message: string): URL {
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(message); }
  if (url.username || url.password || url.hash) throw new Error(message);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback && isLoopback(url)) return url;
  throw new Error(message);
}

/** RFC 8707 / MCP: scheme and host lower-case, no fragment, no trailing slash on a bare origin. */
export function canonicalResource(url: string | URL): string {
  const u = new URL(url.toString());
  u.hash = '';
  return u.pathname === '/' && !u.search ? u.origin : u.toString();
}

function stripSlash(text: string): string { return text.replace(/\/$/, ''); }
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length <= 200) && value.length <= 500 ? value as string[] : undefined;
}
function splitScopes(text: string): string[] {
  return text.split(/\s+/).filter(Boolean).slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * Dynamic client registration (RFC 7591)
 * ------------------------------------------------------------------ */

export interface ClientRegistrationRequest {
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
}

export interface RegisteredClient {
  clientId: string;
  /** Only when the server insisted on a confidential client; buddi asks for none. */
  clientSecret?: string;
  /** Epoch ms, 0 or absent for never. */
  clientSecretExpiresAt?: number;
}

/**
 * Register buddi as a public client (no secret, PKCE) with an authorization
 * server that allows it. One call, never retried; the answer's `client_id` is
 * what the vault keeps beside the tokens.
 */
export async function registerClient(
  registrationEndpoint: string,
  request: ClientRegistrationRequest,
  opts: { transport?: HttpTransport; allowLoopbackHttp?: boolean } = {},
): Promise<RegisteredClient> {
  const transport = opts.transport ?? defaultHttpTransport;
  const endpoint = safeUrl(registrationEndpoint, opts.allowLoopbackHttp === true, 'The registration address is not https.');
  const body = {
    client_name: 'buddi',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...request,
  };
  let res: TransportResponse;
  try {
    res = await transport(endpoint.toString(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), maxBytes: 65536 });
  } catch { throw new Error('Could not reach the server to register buddi. Check the network and try again.'); }
  if (!res.ok) throw new Error(`The server refused to register buddi (${res.status}). It may need a client id entered by hand.`);
  try {
    const data = await res.json() as Record<string, unknown>;
    if (!validToken(data.client_id)) throw new Error();
    const secret = data.client_secret;
    if (secret !== undefined && secret !== null && !validToken(secret)) throw new Error();
    const expires = data.client_secret_expires_at;
    return {
      clientId: data.client_id,
      ...(typeof secret === 'string' ? { clientSecret: secret } : {}),
      ...(typeof expires === 'number' && Number.isFinite(expires) && expires > 0 ? { clientSecretExpiresAt: expires * 1000 } : {}),
    };
  } catch { throw new Error('The server answered the registration with something buddi cannot read.'); }
}

/* ------------------------------------------------------------------ *
 * The token endpoint
 * ------------------------------------------------------------------ */

export interface OAuthClientOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  /** How the token request is encoded. RFC 6749 says form; Claude's endpoint takes JSON. */
  format?: 'form' | 'json';
  /** RFC 8707 resource, sent with every token request and kept on the envelope. */
  resource?: string;
  transport?: HttpTransport;
  now?: () => number;
  /** Refuse an answer without a refresh token. */
  requireRefreshToken?: boolean;
  /** Refuse an answer without `expires_in` (and no `expiryFallback`). */
  requireExpiry?: boolean;
  /** Scopes an answer must grant, or it is refused. */
  requiredScopes?: readonly string[];
  /** Expiry (epoch ms) when the answer has no usable `expires_in`; 0 refuses. */
  expiryFallback?: (data: Record<string, unknown>) => number;
  /**
   * Lifetime assumed when a server gives no `expires_in` and there is no
   * fallback: an hour with a refresh token (a refresh then is harmless), a
   * year without one (the 401 is what ends it, not a guess).
   */
  assumedLifetimeMs?: number;
  /** Shape the envelope from the raw answer: an account id, an id token. Throw to refuse. */
  finish?: (tokens: OAuthTokens, data: Record<string, unknown>, previous?: OAuthTokens) => OAuthTokens;
  /** Error sentences; the defaults name no provider. */
  messages?: { exchange?: string; refresh?: string };
  /** Parameters every token request carries (added before the grant's own). */
  extraParams?: Record<string, string>;
}

const MAX_LIFETIME_S = 366 * 86400;

/** Code exchange and refresh at one token endpoint, for one client. */
export class OAuthClient {
  readonly transport: HttpTransport;
  readonly now: () => number;
  constructor(readonly options: OAuthClientOptions) {
    this.transport = options.transport ?? defaultHttpTransport;
    this.now = options.now ?? Date.now;
  }

  async #token(body: Record<string, string>, requested: readonly string[] | undefined, previous?: OAuthTokens): Promise<OAuthTokens> {
    const o = this.options;
    try {
      const params: Record<string, string> = {
        client_id: o.clientId,
        ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
        ...(o.extraParams ?? {}),
        ...body,
        ...(o.resource ? { resource: o.resource } : {}),
      };
      const res = await this.transport(o.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': o.format === 'json' ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: o.format === 'json' ? JSON.stringify(params) : new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(20_000), maxBytes: 65536,
      });
      if (!res.ok) throw new Error();
      const data = await res.json() as Record<string, unknown>;
      if (!data || typeof data !== 'object' || !validToken(data.access_token)) throw new Error();
      if (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) throw new Error();
      const fresh = data.refresh_token === undefined || data.refresh_token === null || data.refresh_token === '' ? undefined : data.refresh_token;
      if (fresh !== undefined && !validToken(fresh)) throw new Error();
      // A server that does not rotate keeps the old one working.
      const refreshToken = fresh ?? previous?.refreshToken;
      if (o.requireRefreshToken && refreshToken === undefined) throw new Error();
      const expiresIn = typeof data.expires_in === 'string' && /^\d+$/.test(data.expires_in) ? Number(data.expires_in) : data.expires_in;
      let expiresAt: number;
      if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn <= MAX_LIFETIME_S) {
        expiresAt = this.now() + expiresIn * 1000;
      } else if (expiresIn !== undefined && o.requireExpiry) {
        throw new Error();
      } else if (o.expiryFallback) {
        expiresAt = o.expiryFallback(data);
        if (!expiresAt) throw new Error();
      } else if (o.requireExpiry) {
        throw new Error();
      } else {
        expiresAt = this.now() + (o.assumedLifetimeMs ?? (refreshToken ? 3600_000 : 365 * 86400_000));
      }
      const scopes = data.scope === undefined ? (requested ? [...requested] : undefined)
        : typeof data.scope === 'string' && data.scope.length < 4096 ? splitScopes(data.scope) : [];
      for (const scope of o.requiredScopes ?? []) if (!scopes?.includes(scope)) throw new Error();
      const tokens: OAuthTokens = {
        version: 1, state: 'ready', accessToken: data.access_token,
        ...(refreshToken ? { refreshToken } : {}),
        expiresAt,
        ...(scopes ? { scopes } : {}),
        clientId: o.clientId,
        ...(o.resource ? { resource: o.resource } : {}),
      };
      return o.finish ? o.finish(tokens, data, previous) : tokens;
    } catch {
      throw new Error(previous
        ? (o.messages?.refresh ?? 'Token refresh failed. Reconnect this account.')
        : (o.messages?.exchange ?? 'Sign-in could not complete. Start a fresh sign-in.'));
    }
  }

  /** The authorization code for tokens. One request, never retried. */
  exchangeCode(input: { code: string; verifier: string; redirectUri: string; state?: string; scopes?: readonly string[] }): Promise<OAuthTokens> {
    return this.#token({
      grant_type: 'authorization_code', code: input.code,
      ...(input.state !== undefined ? { state: input.state } : {}),
      code_verifier: input.verifier, redirect_uri: input.redirectUri,
    }, input.scopes);
  }

  /** Spend the refresh token for a new pair. The caller persists the answer. */
  refresh(tokens: OAuthTokens, extra: Record<string, string> = {}): Promise<OAuthTokens> {
    if (!tokens.refreshToken) {
      return Promise.reject(new Error(this.options.messages?.refresh ?? 'This sign-in has no refresh token. Reconnect this account.'));
    }
    return this.#token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, ...extra }, tokens.scopes, tokens);
  }
}

/* ------------------------------------------------------------------ *
 * The refresh discipline
 * ------------------------------------------------------------------ */

/** What `refreshDiscipline` needs of a sign-in: how to read its envelope and refresh it. */
export interface RefreshProtocol<T extends { state: 'ready' | 'refreshing'; accessToken: string; expiresAt: number }> {
  read(raw: string): T;
  refresh(tokens: T): Promise<T>;
}

export interface RefreshDisciplineOptions {
  /** Refresh this long before expiry. Five minutes. */
  skewMs?: number;
  /** Rechecked right before the marker is written (the account still exists, still enabled). */
  beforeRefresh?: () => Promise<void>;
  messages?: {
    /** Nothing in the vault. */
    missing?: string;
    /** The entry holds the `refreshing` marker. */
    interrupted?: string;
    /** The refresh call failed; unset keeps the protocol's own sentence. */
    refreshFailed?: string;
    /** Rotated, but the save failed. */
    unsaved?: string;
  };
}

/**
 * The account's tokens, refreshed when they expire within `skewMs`.
 *
 * Order is the whole point. A durable `refreshing` marker is written *before*
 * the refresh token is spent, so a crash, a timeout or a failed save leaves an
 * entry that says "reconnect" rather than one another process would replay.
 * The rotated pair is saved before it is returned; a rotation that could not
 * be saved is never used. If the marker itself cannot be written, nothing is
 * spent. The caller holds the cross-process lock for this account.
 */
export async function refreshDiscipline<T extends { state: 'ready' | 'refreshing'; accessToken: string; expiresAt: number }>(
  vault: Vault,
  ref: string,
  protocol: RefreshProtocol<T>,
  now: () => number = Date.now,
  opts: RefreshDisciplineOptions = {},
): Promise<T> {
  const m = opts.messages ?? {};
  const raw = await vault.get(ref);
  if (!raw) throw new Error(m.missing ?? 'Connect this account first.');
  const tokens = protocol.read(raw);
  if (tokens.state !== 'ready') throw new Error(m.interrupted ?? 'The token refresh was interrupted or failed. Reconnect this account.');
  if (tokens.expiresAt > now() + (opts.skewMs ?? 5 * 60_000)) return tokens;
  await opts.beforeRefresh?.();
  await vault.set(ref, JSON.stringify({ ...tokens, state: 'refreshing' }));
  let rotated: T;
  try { rotated = await protocol.refresh(tokens); }
  catch (error) {
    if (m.refreshFailed !== undefined) throw new Error(m.refreshFailed);
    throw error;
  }
  try { await vault.set(ref, JSON.stringify({ ...rotated, state: 'ready' })); }
  catch { throw new Error(m.unsaved ?? 'The credentials rotated but could not be saved. Reconnect this account.'); }
  return { ...rotated, state: 'ready' };
}
