/**
 * A plugin's OAuth sign-in (host API 1.28, docs/plugin-host-api.md §4.2
 * secrets, docs/owner-secrets.md §3 `http.bearer`).
 *
 * The providers a plugin may sign the owner in to, as data: where consent is
 * asked, where tokens are exchanged and refreshed, and the hosts the tokens
 * may be sent to. A plugin names a provider by id and never an endpoint, so a
 * refresh token only ever goes back to the provider that issued it, and an
 * access token only ever to that provider's API hosts.
 *
 * Pure: names, data and one error class a plugin can recognise.
 */

export interface OAuthProvider {
  /** The owner's word for it. */
  label: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Parameters the consent URL carries beside the standard ones. */
  authorizeExtra: Readonly<Record<string, string>>;
  /** The hosts an access token may go to (exact, or `*.` a domain). */
  apiHosts: readonly string[];
}

/**
 * Google: a Desktop-app client (PKCE, a loopback redirect), offline access so
 * a refresh token comes back, and consent asked every time so a second
 * sign-in gets a refresh token too (Google gives one only on consent).
 */
export const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProvider>> = {
  google: {
    label: 'Google',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    authorizeExtra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' },
    apiHosts: ['www.googleapis.com'],
  },
};

export type OAuthProviderId = keyof typeof OAUTH_PROVIDERS;

/** What a plugin asks for to start a sign-in (`secrets.signIn`). */
export interface OAuthSignInRequest {
  /** A key of `OAUTH_PROVIDERS`: `google`. */
  provider: string;
  /** The plugin's OAuth client. A Desktop client's secret is not confidential (Google says so), and is optional. */
  clientId: string;
  clientSecret?: string;
  /** Every scope the plugin needs; a sign-in that grants fewer fails, saying so. */
  scopes: string[];
  /** The owner secret the tokens are kept under, bound to `http.bearer` for this plugin and `host`. */
  secret: string;
  /** The API host the tokens are sent to: one of the provider's `apiHosts`. */
  host: string;
}

/** A sign-in begun: where to send the owner, and where the provider sends them back. */
export interface OAuthSignInStart {
  id: string;
  /** The provider's consent page, for a link the owner opens. */
  authorizeUrl: string;
  /** `http://127.0.0.1:<port>/`: core listens there until the sign-in ends or expires. */
  redirectUri: string;
  /** ISO time after which the sign-in is dropped. */
  expiresAt: string;
}

/** Where a sign-in stands. `signed-in`: the tokens are in the owner secret. */
export interface OAuthSignInStatus {
  state: 'waiting' | 'signed-in' | 'failed' | 'expired';
  /** Why it failed, in the owner's words. */
  problem?: string;
  /** The scopes granted, once signed in. */
  scopes?: string[];
}

/**
 * A request with `auth: { as: 'bearer' }` found the sign-in no longer works:
 * the provider refused the refresh (revoked, expired — Google's testing-mode
 * tokens last seven days — or the password changed). The owner signs in again;
 * nothing a plugin retries will help. Recognise it by `code`, not `instanceof`:
 * a plugin may load its own copy of this module.
 */
export class SignInExpiredError extends Error {
  override readonly name = 'SignInExpiredError';
  readonly code = 'sign-in-expired';
  constructor(
    readonly secret: string,
    message = `the sign-in kept as "${secret}" no longer works; the owner signs in again`,
  ) {
    super(message);
  }
}

export function isSignInExpired(err: unknown): err is SignInExpiredError {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'sign-in-expired';
}

/** Whether a host is one a pattern names: the same, or under its `*.` domain. */
export function oauthHostCovered(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}
