/**
 * A plugin's OAuth sign-in, run by core on its behalf (host API 1.28,
 * docs/plugin-host-api.md, `secrets.signIn` and `auth: { as: 'bearer' }`).
 *
 * The flow is the one an installed app runs (RFC 8252): PKCE and a state, the
 * provider's consent page opened by the owner, and the answer caught on a
 * loopback port this process listens on for as long as the sign-in waits —
 * `http://127.0.0.1:<port>/`. When the owner's browser is on another computer
 * (a buddi on a home server, the dashboard over the tailnet) that page cannot
 * load there, and the owner pastes the address it ended on instead: the same
 * state check, the same exchange.
 *
 * The tokens go one way: into `save`, which is core writing the owner secret.
 * `fresh` keeps them alive: a refresh at the provider that issued them when
 * the access token is about to expire, or when a 401 answered it. A provider
 * that refuses the refresh (revoked, Google's seven-day testing-mode limit)
 * marks the envelope signed out and throws `SignInExpiredError`, so later
 * requests fail at once, in words, without asking the provider again. Any other
 * failure leaves the envelope as it was: Google does not rotate refresh
 * tokens, so trying again later is safe.
 *
 * Nothing here puts a token, a code or a response body in an error.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { SignInExpiredError, type OAuthSignInStatus, type PluginSignInService, type Vault } from '@buddi/core';
import { OAuthCallbackError, authorizeUrl, oauthState, parseCallback, pkcePair, validToken } from './oauth.js';
import { defaultHttpTransport, type HttpTransport } from './transport.js';

/** How long a sign-in waits for the owner. */
export const SIGN_IN_TTL_MS = 10 * 60_000;
/** How long a finished sign-in's outcome stays readable. */
const KEEP_DONE_MS = 30 * 60_000;
/** Refresh this long before the access token expires. */
const SKEW_MS = 5 * 60_000;

export interface PluginSignInOptions {
  transport?: HttpTransport;
  now?: () => number;
  /** Where the loopback listener binds. `127.0.0.1`. */
  hostname?: string;
}

/** What the vault entry holds: the shared envelope, with the provider's token endpoint and client in `extra`. */
interface Envelope {
  version: 1;
  state: 'ready' | 'refreshing';
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
  clientId?: string;
  extra?: Record<string, string>;
}

interface Pending {
  plugin: string;
  id: string;
  state: string;
  verifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  label: string;
  clientId: string;
  clientSecret?: string;
  scopes: readonly string[];
  save(envelope: string): Promise<void>;
  status: OAuthSignInStatus;
  exchanging?: Promise<OAuthSignInStatus>;
  server?: Server;
  timer?: NodeJS.Timeout;
}

const page = (title: string, text: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${title}</title><style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;` +
  `background:#faf9f7;color:#1f1d1a}@media (prefers-color-scheme:dark){body{background:#1b1a18;color:#ecebe8}}main{max-width:28rem;padding:1.5rem}` +
  `h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

function sendPage(res: ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  res.end(page(title, text));
}

/** The provider's `error` code from a token endpoint's JSON answer, if it gave one. */
async function errorCode(res: { json(): Promise<unknown> }): Promise<string | undefined> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data?.error === 'string' ? data.error : undefined;
  } catch {
    return undefined;
  }
}

/** A token endpoint's answer as an envelope's fields, or undefined when it is not one. */
async function tokensOf(res: { json(): Promise<unknown> }, now: number): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; scopes?: string[] } | undefined> {
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || !validToken(data.access_token)) return undefined;
  if (data.token_type !== undefined && String(data.token_type).toLowerCase() !== 'bearer') return undefined;
  const refresh = data.refresh_token;
  if (refresh !== undefined && refresh !== null && refresh !== '' && !validToken(refresh)) return undefined;
  const seconds = Number(data.expires_in);
  const expiresAt = now + (Number.isFinite(seconds) && seconds > 0 && seconds <= 366 * 86400 ? seconds : 3600) * 1000;
  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : undefined;
  return {
    accessToken: data.access_token as string,
    ...(typeof refresh === 'string' && refresh !== '' ? { refreshToken: refresh } : {}),
    expiresAt,
    ...(scopes ? { scopes } : {}),
  };
}

function readEnvelope(raw: string | null, secret: string): Envelope {
  if (raw === null || raw === '') throw new SignInExpiredError(secret, `"${secret}" holds no sign-in; the owner signs in again`);
  let data: Envelope;
  try {
    data = JSON.parse(raw) as Envelope;
  } catch {
    throw new SignInExpiredError(secret, `"${secret}" is not a sign-in buddi can read; the owner signs in again`);
  }
  if (!data || data.version !== 1 || !validToken(data.accessToken) || typeof data.expiresAt !== 'number') {
    throw new SignInExpiredError(secret, `"${secret}" is not a sign-in buddi can read; the owner signs in again`);
  }
  return data;
}

export function createPluginSignInService(options: PluginSignInOptions = {}): PluginSignInService {
  const transport = options.transport ?? defaultHttpTransport;
  const now = options.now ?? Date.now;
  const hostname = options.hostname ?? '127.0.0.1';
  const pending = new Map<string, Pending>();
  /** One refresh at a time per vault entry: a second caller waits and reads what the first saved. */
  const refreshing = new Map<string, Promise<unknown>>();

  /** Stop listening; the answer being written still goes out (every answer closes its connection). */
  const close = (entry: Pending): void => {
    const server = entry.server;
    if (server === undefined) return;
    delete entry.server;
    server.close();
    setTimeout(() => server.closeAllConnections?.(), 2_000).unref();
  };
  const end = (entry: Pending, status: OAuthSignInStatus): OAuthSignInStatus => {
    entry.status = status;
    close(entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => pending.delete(entry.id), KEEP_DONE_MS);
    entry.timer.unref();
    return status;
  };

  /** The code for tokens, once per sign-in: the loopback and a paste racing get the same answer. */
  const exchange = (entry: Pending, code: string): Promise<OAuthSignInStatus> => {
    if (entry.status.state !== 'waiting') return Promise.resolve(entry.status);
    entry.exchanging ??= (async (): Promise<OAuthSignInStatus> => {
      let res;
      try {
        res = await transport(entry.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: entry.verifier,
            redirect_uri: entry.redirectUri,
            client_id: entry.clientId,
            ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}),
          }).toString(),
          signal: AbortSignal.timeout(20_000),
          maxBytes: 65_536,
        });
      } catch {
        return end(entry, { state: 'failed', problem: `${entry.label} did not answer the sign-in. Start again.` });
      }
      if (!res.ok) {
        const why = await errorCode(res);
        return end(entry, {
          state: 'failed',
          problem: why === 'invalid_grant'
            ? `${entry.label} refused the code: it works once and only for a few minutes. Start again.`
            : why === 'invalid_client' || why === 'unauthorized_client'
              ? `${entry.label} turned down the plugin's OAuth client (${why}): its client id or secret is wrong or missing. Update the plugin.`
              : `${entry.label} refused the sign-in (${res.status}). Start again.`,
        });
      }
      const tokens = await tokensOf(res, now());
      if (tokens === undefined) return end(entry, { state: 'failed', problem: `${entry.label} answered the sign-in with something buddi cannot read. Start again.` });
      if (tokens.refreshToken === undefined) {
        return end(entry, { state: 'failed', problem: `${entry.label} gave buddi no lasting access. Start again, and allow it on ${entry.label}'s page.` });
      }
      const granted = tokens.scopes ?? [...entry.scopes];
      if (entry.scopes.some((scope) => !granted.includes(scope))) {
        return end(entry, {
          state: 'failed',
          problem: `${entry.label} did not give buddi everything it asks for. Start again and tick every box on ${entry.label}'s page.`,
        });
      }
      const envelope: Envelope = {
        version: 1,
        state: 'ready',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: granted,
        clientId: entry.clientId,
        extra: { tokenEndpoint: entry.tokenEndpoint, ...(entry.clientSecret ? { clientSecret: entry.clientSecret } : {}) },
      };
      try {
        await entry.save(JSON.stringify(envelope));
      } catch (err) {
        return end(entry, { state: 'failed', problem: `buddi signed in but could not keep the sign-in: ${err instanceof Error ? err.message : String(err)}` });
      }
      return end(entry, { state: 'signed-in', scopes: granted });
    })();
    return entry.exchanging;
  };

  async function onCallback(entry: Pending, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') return sendPage(res, 405, 'Not here', 'This address only takes the sign-in answer.');
    const url = new URL(req.url ?? '/', entry.redirectUri);
    if (url.pathname !== new URL(entry.redirectUri).pathname || (!url.searchParams.has('code') && !url.searchParams.has('error'))) {
      return sendPage(res, 404, 'Not here', 'This address only takes the sign-in answer.');
    }
    let code: string;
    try {
      ({ code } = parseCallback(url, entry.state, { redirectUri: entry.redirectUri }));
    } catch (err) {
      if (err instanceof OAuthCallbackError && err.reason === 'denied') {
        end(entry, { state: 'failed', problem: `You did not allow buddi on ${entry.label}'s page. Start again to sign in.` });
        return sendPage(res, 200, 'Not signed in', `You did not allow buddi. Go back to buddi to start again.`);
      }
      return sendPage(res, 400, 'Not this sign-in', 'This answer is not for the sign-in buddi started. Go back to buddi and start again.');
    }
    const status = await exchange(entry, code);
    if (status.state === 'signed-in') {
      return sendPage(res, 200, `Signed in to ${entry.label}`, 'buddi has the sign-in. Close this tab and go back to buddi to finish.');
    }
    return sendPage(res, 200, 'Not signed in', `${status.problem ?? 'The sign-in did not finish.'}`);
  }

  return {
    async begin(input) {
      // One waiting sign-in per plugin: a second press replaces the first.
      for (const other of pending.values()) {
        if (other.plugin === input.plugin && other.status.state === 'waiting') {
          end(other, { state: 'expired', problem: 'A newer sign-in replaced this one.' });
        }
      }
      const pkce = pkcePair();
      const entry: Pending = {
        plugin: input.plugin,
        id: randomBytes(12).toString('base64url'),
        state: oauthState(),
        verifier: pkce.verifier,
        redirectUri: '',
        tokenEndpoint: input.provider.tokenEndpoint,
        label: input.provider.label,
        clientId: input.clientId,
        ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
        scopes: [...input.scopes],
        save: input.save,
        status: { state: 'waiting' },
      };
      const server = createServer((req, res) => {
        onCallback(entry, req, res).catch(() => sendPage(res, 500, 'Not signed in', 'Something went wrong. Go back to buddi and start again.'));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, hostname, () => resolve());
      });
      server.unref();
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        throw new Error('buddi could not listen for the sign-in answer.');
      }
      entry.server = server;
      entry.redirectUri = `http://${hostname}:${address.port}/`;
      entry.timer = setTimeout(() => {
        if (entry.status.state === 'waiting') end(entry, { state: 'expired', problem: 'The sign-in waited too long. Start again.' });
      }, SIGN_IN_TTL_MS);
      entry.timer.unref();
      pending.set(entry.id, entry);
      const consent = authorizeUrl({
        authorizationEndpoint: input.provider.authorizationEndpoint,
        clientId: input.clientId,
        redirectUri: entry.redirectUri,
        state: entry.state,
        challenge: pkce.challenge,
        scopes: input.scopes,
        extra: { ...input.provider.authorizeExtra },
      });
      return { id: entry.id, authorizeUrl: consent, redirectUri: entry.redirectUri, expiresAt: now() + SIGN_IN_TTL_MS };
    },

    status(plugin, id) {
      const entry = pending.get(id);
      return entry && entry.plugin === plugin ? { ...entry.status } : undefined;
    },

    async finish(plugin, id, pasted) {
      const entry = pending.get(id);
      if (!entry || entry.plugin !== plugin) return { state: 'expired', problem: 'That sign-in is over. Start again.' };
      if (entry.status.state !== 'waiting') return { ...entry.status };
      const text = pasted.trim();
      let code: string;
      if (/^https?:\/\//i.test(text)) {
        try {
          ({ code } = parseCallback(text, entry.state, { redirectUri: entry.redirectUri }));
        } catch (err) {
          if (err instanceof OAuthCallbackError && err.reason === 'denied') {
            return end(entry, { state: 'failed', problem: `You did not allow buddi on ${entry.label}'s page. Start again to sign in.` });
          }
          if (err instanceof OAuthCallbackError && (err.reason === 'state' || err.reason === 'foreign')) {
            throw new Error('That address is from another sign-in. Paste the one from the tab this sign-in opened.');
          }
          throw new Error('That address has no sign-in code in it. Paste the whole address from the tab, as it is.');
        }
      } else {
        if (!/^[\x21-\x7e]{10,4096}$/.test(text)) throw new Error('Paste the whole address the browser ended on.');
        code = text;
      }
      return exchange(entry, code);
    },

    cancel(plugin, id) {
      const entry = pending.get(id);
      if (!entry || entry.plugin !== plugin) return;
      close(entry);
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(id);
    },

    async fresh(vault: Pick<Vault, 'get' | 'set'>, ref: string, secret: string, opts: { rejected?: string } = {}) {
      const before = refreshing.get(ref);
      const run = (async () => {
        if (before) await before.catch(() => undefined);
        const tokens = readEnvelope(await vault.get(ref), secret);
        if (tokens.extra?.signedOut) throw new SignInExpiredError(secret);
        const stale = opts.rejected !== undefined && opts.rejected === tokens.accessToken;
        if (!stale && (opts.rejected !== undefined || tokens.expiresAt > now() + SKEW_MS)) {
          // Fresh enough, or another request already replaced the token a 401 answered.
          return { accessToken: tokens.accessToken, refreshed: false };
        }
        const tokenEndpoint = tokens.extra?.tokenEndpoint;
        if (!tokens.refreshToken || !tokenEndpoint || !tokens.clientId) {
          throw new SignInExpiredError(secret, `"${secret}" cannot be renewed; the owner signs in again`);
        }
        let res;
        try {
          res = await transport(tokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: tokens.refreshToken,
              client_id: tokens.clientId,
              ...(tokens.extra?.clientSecret ? { client_secret: tokens.extra.clientSecret } : {}),
            }).toString(),
            signal: AbortSignal.timeout(20_000),
            maxBytes: 65_536,
          });
        } catch {
          throw new Error(`the sign-in "${secret}" could not be renewed just now (no answer); buddi tries again on the next request`);
        }
        if (!res.ok) {
          const why = await errorCode(res);
          if (why === 'invalid_grant' || why === 'invalid_client' || why === 'unauthorized_client' || res.status === 401) {
            await vault.set(ref, JSON.stringify({ ...tokens, state: 'ready', extra: { ...(tokens.extra ?? {}), signedOut: why ?? String(res.status) } }));
            throw new SignInExpiredError(secret);
          }
          throw new Error(`the sign-in "${secret}" could not be renewed just now (${res.status}); buddi tries again on the next request`);
        }
        const next = await tokensOf(res, now());
        if (next === undefined) throw new Error(`the sign-in "${secret}" was renewed with an answer buddi cannot read; buddi tries again on the next request`);
        const rotated: Envelope = {
          ...tokens,
          state: 'ready',
          accessToken: next.accessToken,
          refreshToken: next.refreshToken ?? tokens.refreshToken,
          expiresAt: next.expiresAt,
          ...(next.scopes ? { scopes: next.scopes } : {}),
        };
        await vault.set(ref, JSON.stringify(rotated));
        return { accessToken: rotated.accessToken, refreshed: true };
      })();
      refreshing.set(ref, run);
      try {
        return await run;
      } finally {
        if (refreshing.get(ref) === run) refreshing.delete(ref);
      }
    },
  };
}
