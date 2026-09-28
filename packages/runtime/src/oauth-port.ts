/**
 * The shared OAuth module as one object a plugin is handed
 * (buddi-planning/specs/mcp-client.md §4, docs/connections.md).
 *
 * A plugin reaches core through `ctx.buddi` and `@buddi/core/plugin` only, so
 * it cannot import this package. The gateway builds this over the one shared
 * transport and hands it to the connections plugin: discovery, registration,
 * PKCE, the authorize URL, the code exchange and the refresh discipline, the
 * same code the Claude and ChatGPT sign-ins run. Nothing here returns a token
 * to anyone but the caller that stores it or puts it in a header.
 */
import type { Vault } from '@buddi/core';
import {
  authorizeUrl,
  discoverAuthorization,
  OAuthClient,
  oauthState,
  pkcePair,
  readOAuthTokens,
  refreshDiscipline,
  registerClient,
  validOAuthId,
  validToken,
  type AuthorizeUrlParams,
  type DiscoveredAuthorization,
  type OAuthTokens,
} from './oauth.js';
import { defaultHttpTransport, type HttpTransport } from './transport.js';

export interface OAuthPortOptions {
  transport?: HttpTransport;
  /** `http://` on loopback for servers and authorization servers: tests only. */
  allowLoopbackHttp?: boolean;
  now?: () => number;
}

export interface OAuthPort {
  discover(resourceUrl: string, opts: { wwwAuthenticate: string | null }): Promise<DiscoveredAuthorization>;
  register(registrationEndpoint: string, request: { client_name?: string; redirect_uris: string[]; scope?: string }): Promise<{ clientId: string; clientSecret?: string }>;
  pkce(): { verifier: string; challenge: string };
  state(): string;
  authorizeUrl(params: AuthorizeUrlParams): string;
  validClientId(id: string): boolean;
  /** The code for tokens. `extra` is kept on the envelope (the token endpoint a refresh goes to). */
  exchange(input: {
    tokenEndpoint: string; clientId: string; clientSecret?: string; resource: string;
    code: string; verifier: string; redirectUri: string; scopes: readonly string[];
    extra: Record<string, string>; failure: string;
  }): Promise<OAuthTokens>;
  /**
   * The envelope under `ref`, refreshed first when it expires within five
   * minutes, under the durable-marker discipline. The refresh goes to
   * `extra.tokenEndpoint` with the envelope's own client id and resource.
   */
  fresh(vault: Pick<Vault, 'get' | 'set'>, ref: string, messages: {
    invalid: string; missing: string; interrupted: string; refreshFailed: string; unsaved: string; cannotRenew: string;
  }): Promise<OAuthTokens>;
}

export function createOAuthPort(options: OAuthPortOptions = {}): OAuthPort {
  const transport = options.transport ?? defaultHttpTransport;
  const loopback = options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {};
  const now = options.now ?? Date.now;
  return {
    discover: (resourceUrl, opts) => discoverAuthorization(resourceUrl, { transport, wwwAuthenticate: opts.wwwAuthenticate, ...loopback }),
    register: async (endpoint, request) => {
      const registered = await registerClient(endpoint, request, { transport, ...loopback });
      return { clientId: registered.clientId, ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}) };
    },
    pkce: () => pkcePair(),
    state: () => oauthState(),
    authorizeUrl: (params) => authorizeUrl(params),
    validClientId: (id) => validOAuthId(id) || validToken(id),
    exchange: async (input) => {
      const client = new OAuthClient({
        tokenEndpoint: input.tokenEndpoint, clientId: input.clientId,
        ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
        resource: input.resource, transport, now,
        messages: { exchange: input.failure },
      });
      const tokens = await client.exchangeCode({ code: input.code, verifier: input.verifier, redirectUri: input.redirectUri, scopes: input.scopes });
      return { ...tokens, extra: { ...(tokens.extra ?? {}), ...input.extra } };
    },
    fresh: (vault, ref, messages) => refreshDiscipline(vault as Vault, ref, {
      read: (raw) => readOAuthTokens(raw, { invalidMessage: messages.invalid }),
      refresh: (tokens) => {
        const tokenEndpoint = tokens.extra?.tokenEndpoint;
        if (!tokenEndpoint || !tokens.clientId) return Promise.reject(new Error(messages.cannotRenew));
        return new OAuthClient({
          tokenEndpoint,
          clientId: tokens.clientId,
          ...(tokens.extra?.clientSecret ? { clientSecret: tokens.extra.clientSecret } : {}),
          ...(tokens.resource ? { resource: tokens.resource } : {}),
          transport, now,
          finish: (next, _data, previous) => ({ ...next, ...(previous?.extra ? { extra: previous.extra } : {}) }),
          messages: { refresh: messages.refreshFailed },
        }).refresh(tokens);
      },
    }, now, {
      messages: {
        missing: messages.missing, interrupted: messages.interrupted,
        refreshFailed: messages.refreshFailed, unsaved: messages.unsaved,
      },
    }),
  };
}
