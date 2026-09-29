/**
 * What the gateway hands this plugin (docs/connections.md). A plugin reaches
 * core through `ctx.buddi` and `@buddi/core/plugin` alone, so the pieces that
 * are buddi's own code — the one outbound transport, the vault, the shared
 * OAuth module — arrive as these ports, built by the composition root over
 * the real thing (`@buddi/runtime`'s `createOAuthPort`, `defaultHttpTransport`).
 */

/** The slice of a response this plugin reads. */
export interface TransportResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The shared outbound transport: one connection per request, no redirects followed. */
export type HttpTransport = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer | undefined;
  signal?: AbortSignal | undefined;
  idleTimeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}) => Promise<TransportResponse>;

/** Where a connection's sign-in is kept. */
export interface VaultPort {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** The shared `OAuthTokens` envelope, as far as this plugin reads it. */
export interface OAuthTokens {
  version: 1;
  state: 'ready' | 'refreshing';
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
  clientId?: string;
  resource?: string;
  extra?: Record<string, string>;
}

export interface DiscoveredAuthorization {
  resource: string;
  authorizationServer: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
  };
  scopes: string[];
}

/** The shared OAuth module (`@buddi/runtime`'s `createOAuthPort`). */
export interface OAuthPort {
  discover(resourceUrl: string, opts: { wwwAuthenticate: string | null }): Promise<DiscoveredAuthorization>;
  register(registrationEndpoint: string, request: { client_name?: string; redirect_uris: string[]; scope?: string }): Promise<{ clientId: string; clientSecret?: string }>;
  pkce(): { verifier: string; challenge: string };
  state(): string;
  authorizeUrl(params: {
    authorizationEndpoint: string; clientId: string; redirectUri: string; state: string; challenge: string;
    scopes?: readonly string[]; resource?: string;
  }): string;
  validClientId(id: string): boolean;
  exchange(input: {
    tokenEndpoint: string; clientId: string; clientSecret?: string; resource: string;
    code: string; verifier: string; redirectUri: string; scopes: readonly string[];
    extra: Record<string, string>; failure: string;
  }): Promise<OAuthTokens>;
  fresh(vault: Pick<VaultPort, 'get' | 'set'>, ref: string, messages: {
    invalid: string; missing: string; interrupted: string; refreshFailed: string; unsaved: string; cannotRenew: string;
  }): Promise<OAuthTokens>;
}

/** Where a token-signed connection's header goes: its host and the header's name. */
export interface HeaderTarget {
  host: string;
  header: string;
}

/**
 * The owner's secrets, for a connection signed in with a token
 * (docs/owner-secrets.md, `http.header`). The composition root builds it over
 * core's secret store: `put` keeps the value bound to this connection's host
 * and header, pre-approved, and `value` is one recorded use of that binding,
 * answered only for that host and header. No other code reads the value.
 */
export interface SecretsPort {
  put(name: string, value: string, target: HeaderTarget): Promise<void>;
  /** The value for this host and header, or a thrown sentence when the binding refuses it. */
  value(name: string, target: HeaderTarget): Promise<string>;
  remove(name: string): Promise<void>;
}
