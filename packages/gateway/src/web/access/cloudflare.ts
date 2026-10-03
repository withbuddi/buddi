/**
 * Provider 2: Cloudflare Tunnel + Cloudflare Access (specs/trusted-access.md §5).
 *
 * The tunnel (cloudflared, on this machine) carries the traffic to the
 * ingress listener; Access, at Cloudflare's edge, decides who may pass and
 * puts a signed JWT on every request it lets through, in the
 * `Cf-Access-Jwt-Assertion` header. buddi verifies that JWT itself, on every
 * request, and never trusts a plain header:
 *
 *   1. The request arrived on the ingress listener (`arrival.ts`). A JWT on
 *      the main listener is a replay from a local process, and earns nothing.
 *   2. The header is present, once. The `CF_Authorization` cookie is ignored:
 *      the header is what Access adds at the edge, the cookie is what a
 *      browser can carry anywhere.
 *   3. The signature verifies (RS256) against the team's keys from
 *      `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached by
 *      `kid` for an hour, refetched on an unknown `kid` at most once a minute.
 *   4. `iss` is `https://<team>.cloudflareaccess.com`; `aud` contains the
 *      application's AUD tag; `exp` and `nbf` hold, with 60 seconds of skew.
 *   5. The `email` claim is the allowed email (compared as Tailscale logins
 *      are). A service-token JWT (no `email`, a `common_name`) is refused.
 *
 * `Cf-Connecting-Ip`, `Cf-Access-Authenticated-User-Email` and every other
 * header are never identity. `Cf-Connecting-Ip` is a rate-limit bucket, and
 * only after the JWT verified.
 *
 * Replay: within its life a JWT is a bearer credential — that is Access's
 * model, and the browser presents the same one on every request. buddi adds
 * the arrival check (it must come through the tunnel), the `exp` with a small
 * skew, and on a session the JWT must keep naming the same email.
 */
import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { defaultHttpTransport, type HttpTransport } from '@buddi/runtime';
import { arrivalOf } from './arrival.js';
import {
  sameSubject,
  type AccessConfirmation,
  type AccessContext,
  type AccessIdentifyResult,
  type AccessProvider,
  type AccessRefusal,
  type AccessSetup,
  type AccessStatus,
} from './provider.js';

export const CLOUDFLARE_SETTING_KEY = 'access.cloudflare';
export const CF_ASSERTION_HEADER = 'cf-access-jwt-assertion';

/** How long the team's keys are used before they are fetched again. */
export const JWKS_CACHE_MS = 60 * 60_000;
/** The least time between two fetches, whatever `kid` turns up. */
export const JWKS_REFETCH_MIN_MS = 60_000;
/** Clock skew allowed on `exp`, `nbf` and `iat`. */
export const JWT_SKEW_MS = 60_000;
/** The hard cap on a Cloudflare session, and on any JWT's own lifetime. */
export const CLOUDFLARE_ABSOLUTE_CAP_MS = 7 * 24 * 60 * 60_000;
/** The largest assertion read. Access's are about a kilobyte. */
const MAX_ASSERTION = 16_384;

export interface CloudflareAccessSetting {
  enabled: boolean;
  /** `<team>.cloudflareaccess.com`, lower case, no scheme. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** The one email allowed to sign in. */
  email: string;
  /** The public hostname as an origin (`https://buddi.example.com`), or empty. */
  publicOrigin: string;
}

/** Shape checks only; nothing here proves a team or an email exists. */
export function normalizeTeamDomain(raw: string): string {
  let value = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) value = `${value}.cloudflareaccess.com`;
  return value;
}
export function plausibleTeamDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/.test(value);
}
export function plausibleAud(value: string): boolean {
  return /^[A-Za-z0-9]{16,128}$/.test(value);
}
export function plausibleEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}
/** An `https://` origin with nothing after the host, or null. */
export function normalizePublicOrigin(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return '';
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** What is stored, made safe: anything unexpected in the row reads as off. */
export function toCloudflareSetting(value: unknown): CloudflareAccessSetting {
  const row = (value ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const teamDomain = normalizeTeamDomain(str(row.teamDomain));
  const aud = str(row.aud);
  const email = str(row.email);
  const origin = normalizePublicOrigin(str(row.publicOrigin)) ?? '';
  const complete = plausibleTeamDomain(teamDomain) && plausibleAud(aud) && plausibleEmail(email);
  return { enabled: row.enabled === true && complete, teamDomain, aud, email, publicOrigin: origin };
}

/** What is missing before this can be turned on, in words; empty when nothing. */
export function cloudflareMissing(setting: Pick<CloudflareAccessSetting, 'teamDomain' | 'aud' | 'email'>): string[] {
  const missing: string[] = [];
  if (!plausibleTeamDomain(setting.teamDomain)) missing.push('the team domain');
  if (!plausibleAud(setting.aud)) missing.push('the AUD tag');
  if (!plausibleEmail(setting.email)) missing.push('your email');
  return missing;
}

/** "a, b and c". */
export function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The owner's input to the panel, validated: the setting to store, or the
 * sentence saying what is wrong with it.
 */
export function validateCloudflareInput(input: Record<string, unknown>): { ok: true; value: CloudflareAccessSetting } | { ok: false; error: string } {
  if (typeof input.enabled !== 'boolean') return { ok: false, error: '`enabled` must be true or false' };
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const teamDomain = normalizeTeamDomain(str(input.teamDomain));
  const aud = str(input.aud);
  const email = str(input.email);
  const origin = normalizePublicOrigin(str(input.publicOrigin));
  if (teamDomain !== '' && !plausibleTeamDomain(teamDomain)) {
    return { ok: false, error: 'That is not a Cloudflare team domain. It looks like yourteam.cloudflareaccess.com, under Zero Trust → Settings.' };
  }
  if (aud !== '' && !plausibleAud(aud)) {
    return { ok: false, error: 'That is not an AUD tag. It is the long string of letters and digits on the Access application’s Overview tab.' };
  }
  if (email !== '' && !plausibleEmail(email)) return { ok: false, error: 'That is not an email address.' };
  if (origin === null) return { ok: false, error: 'The public address must be an https:// address with nothing after the host, like https://buddi.example.com.' };
  if (input.enabled) {
    const missing = cloudflareMissing({ teamDomain, aud, email });
    if (missing.length > 0) return { ok: false, error: `To turn this on, fill in ${listInWords(missing)}.` };
  }
  return { ok: true, value: { enabled: input.enabled, teamDomain, aud, email, publicOrigin: origin } };
}

/* ------------------------------------------------------------------ *
 * The team's keys
 * ------------------------------------------------------------------ */

export type JwksAnswer = KeyObject | 'unknown' | 'unanswered';

export interface JwksFetchResult {
  ok: boolean;
  /** How many RS256 signing keys came back. */
  keys: number;
  /** Why not, in words, when `ok` is false. Never echoes a body. */
  error?: string | undefined;
}

export interface Jwks {
  /** The key for this `kid`: fetched once on a miss, at most once a minute. */
  key(teamDomain: string, kid: string): Promise<JwksAnswer>;
  /** Fetch the team's keys now, whatever the cache holds (Save, Test my setup). */
  refresh(teamDomain: string): Promise<JwksFetchResult>;
  /** Did the last fetch for this team fail? */
  failing(teamDomain: string): boolean;
}

export function certsUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

/**
 * The team's JWKS, cached by `kid`.
 *
 * One cache per team domain, so changing the setting never mixes keys. A key
 * set is used for an hour; an unknown `kid` refetches at once unless a fetch
 * happened in the last minute (a stranger varying `kid` cannot make the
 * gateway hammer Cloudflare). A fetch that fails is never cached as "no keys":
 * the request is `unanswered` and the next one asks again, within the budget.
 */
export function createJwks(deps: { transport?: HttpTransport | undefined; now?: (() => Date) | undefined; log?: ((line: string) => void) | undefined } = {}): Jwks {
  const transport = deps.transport ?? defaultHttpTransport;
  const now = deps.now ?? (() => new Date());
  const teams = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number; triedAt: number; failing: boolean; inFlight?: Promise<JwksFetchResult> }>();

  const entry = (team: string) => {
    let e = teams.get(team);
    if (!e) {
      if (teams.size > 8) teams.clear();
      e = { keys: new Map(), fetchedAt: Number.NEGATIVE_INFINITY, triedAt: Number.NEGATIVE_INFINITY, failing: false };
      teams.set(team, e);
    }
    return e;
  };

  const fetchKeys = (team: string): Promise<JwksFetchResult> => {
    const e = entry(team);
    if (e.inFlight) return e.inFlight;
    e.triedAt = now().getTime();
    const run = (async (): Promise<JwksFetchResult> => {
      try {
        const res = await transport(certsUrl(team), { method: 'GET', headers: { accept: 'application/json' }, idleTimeoutMs: 5_000, maxBytes: 256_000 });
        if (!res.ok) {
          e.failing = true;
          return { ok: false, keys: 0, error: `${team} didn’t answer with signing keys (${res.status}). Check the team domain.` };
        }
        const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
        const keys = new Map<string, KeyObject>();
        for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
          const k = jwk as { kid?: unknown; kty?: unknown; alg?: unknown; use?: unknown };
          if (typeof k.kid !== 'string' || k.kty !== 'RSA') continue;
          if (k.alg !== undefined && k.alg !== 'RS256') continue;
          if (k.use !== undefined && k.use !== 'sig') continue;
          try {
            keys.set(k.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
          } catch { /* a key that does not parse is not a key */ }
        }
        if (keys.size === 0) {
          e.failing = true;
          return { ok: false, keys: 0, error: `${team} answered, but with no signing keys buddi can use.` };
        }
        e.keys = keys;
        e.fetchedAt = now().getTime();
        e.failing = false;
        return { ok: true, keys: keys.size };
      } catch (err) {
        e.failing = true;
        deps.log?.(`access: fetching Cloudflare's signing keys failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, keys: 0, error: `${team} could not be reached just now. Check the team domain and this computer’s connection.` };
      } finally {
        delete e.inFlight;
      }
    })();
    e.inFlight = run;
    return run;
  };

  return {
    async key(team, kid) {
      const e = entry(team);
      const at = now().getTime();
      const fresh = at - e.fetchedAt < JWKS_CACHE_MS;
      const hit = e.keys.get(kid);
      if (hit && fresh) return hit;
      if (at - e.triedAt < JWKS_REFETCH_MIN_MS && !e.inFlight) {
        // Asked a moment ago. A stale set still answers for a known kid until
        // the next fetch is allowed; an unknown kid waits.
        if (hit) return hit;
        return e.failing ? 'unanswered' : 'unknown';
      }
      const result = await fetchKeys(team);
      if (!result.ok) return 'unanswered';
      return e.keys.get(kid) ?? 'unknown';
    },
    refresh: (team) => fetchKeys(team),
    failing: (team) => teams.get(team)?.failing ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * The JWT
 * ------------------------------------------------------------------ */

export type CloudflareRefusal =
  | 'setting-off'
  | 'not-through-the-tunnel'
  | 'no-assertion'
  | 'malformed'
  | 'wrong-algorithm'
  | 'unknown-key'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'not-yet-valid'
  | 'too-long-lived'
  | 'service-token'
  | 'email-not-allowed'
  | 'keys-unreachable';

const REASONS: Readonly<Record<CloudflareRefusal, string>> = {
  'setting-off': 'a request arrived through the tunnel but signing in through Cloudflare is off',
  'not-through-the-tunnel': 'a Cloudflare Access assertion arrived somewhere other than the ingress listener',
  'no-assertion': 'a request arrived through the tunnel without Cloudflare Access’s signed assertion',
  malformed: 'the Cloudflare Access assertion is not a JWT buddi can read',
  'wrong-algorithm': 'the Cloudflare Access assertion is not signed with RS256',
  'unknown-key': 'the Cloudflare Access assertion is signed with a key the team does not publish',
  'bad-signature': 'the Cloudflare Access assertion’s signature does not verify',
  'wrong-issuer': 'the Cloudflare Access assertion was issued by another team',
  'wrong-audience': 'the Cloudflare Access assertion is for another application',
  expired: 'the Cloudflare Access assertion has expired',
  'not-yet-valid': 'the Cloudflare Access assertion is not valid yet',
  'too-long-lived': 'the Cloudflare Access assertion claims a lifetime longer than seven days',
  'service-token': 'the Cloudflare Access assertion is a service token, not a person',
  'email-not-allowed': 'the email Cloudflare signed in is not the one allowed to sign in through Cloudflare',
  'keys-unreachable': 'Cloudflare’s signing keys could not be fetched just now',
};

export function cloudflareRefusalReason(reason: CloudflareRefusal): string {
  return REASONS[reason];
}

function refusalOf(reason: CloudflareRefusal): AccessRefusal {
  return {
    refusal: reason,
    sentence: REASONS[reason],
    kind: reason === 'keys-unreachable' ? 'unanswered' : reason === 'email-not-allowed' ? 'login' : 'other',
  };
}

export interface VerifiedAssertion {
  email: string;
  expiresAt: Date;
  issuedAt?: Date | undefined;
}

function b64json(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verify one assertion against the setting: steps 3–5 above. Never throws.
 */
export async function verifyAccessJwt(
  token: string,
  setting: Pick<CloudflareAccessSetting, 'teamDomain' | 'aud' | 'email'>,
  deps: { jwks: Jwks; now: Date },
): Promise<{ ok: true; assertion: VerifiedAssertion } | { ok: false; reason: CloudflareRefusal }> {
  if (token.length > MAX_ASSERTION) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  const header = b64json(h);
  const payload = b64json(p);
  if (!header || !payload) return { ok: false, reason: 'malformed' };
  // Only RS256: never `none`, never an HMAC a public key could be fed into.
  if (header.alg !== 'RS256') return { ok: false, reason: 'wrong-algorithm' };
  if (typeof header.kid !== 'string' || header.kid === '' || header.kid.length > 256) return { ok: false, reason: 'malformed' };

  const key = await deps.jwks.key(setting.teamDomain, header.kid);
  if (key === 'unanswered') return { ok: false, reason: 'keys-unreachable' };
  if (key === 'unknown') return { ok: false, reason: 'unknown-key' };
  let good = false;
  try {
    good = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf8'), key, Buffer.from(s, 'base64url'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad-signature' };

  if (payload.iss !== `https://${setting.teamDomain}`) return { ok: false, reason: 'wrong-issuer' };
  const aud = payload.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.some((a) => typeof a === 'string' && a === setting.aud)) return { ok: false, reason: 'wrong-audience' };

  const at = deps.now.getTime();
  const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : NaN;
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (exp + JWT_SKEW_MS <= at) return { ok: false, reason: 'expired' };
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number') return { ok: false, reason: 'malformed' };
    if (payload.nbf * 1000 - JWT_SKEW_MS > at) return { ok: false, reason: 'not-yet-valid' };
  }
  let issuedAt: Date | undefined;
  if (payload.iat !== undefined) {
    if (typeof payload.iat !== 'number') return { ok: false, reason: 'malformed' };
    if (payload.iat * 1000 - JWT_SKEW_MS > at) return { ok: false, reason: 'not-yet-valid' };
    issuedAt = new Date(payload.iat * 1000);
  }
  if (exp - at > CLOUDFLARE_ABSOLUTE_CAP_MS + JWT_SKEW_MS) return { ok: false, reason: 'too-long-lived' };

  // A service token names a `common_name`, not a person.
  if (typeof payload.email !== 'string' || payload.email.trim() === '') return { ok: false, reason: 'service-token' };
  if (!sameSubject(payload.email, setting.email)) return { ok: false, reason: 'email-not-allowed' };
  return { ok: true, assertion: { email: payload.email.trim(), expiresAt: new Date(exp), ...(issuedAt ? { issuedAt } : {}) } };
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

export interface CloudflareProviderDeps {
  jwks: Jwks;
  log?: ((line: string) => void) | undefined;
  /** The ingress listener could not be bound, in words; null while it is fine. */
  ingressProblem?: (() => string | null) | undefined;
}

export interface CloudflareProvider extends AccessProvider<CloudflareAccessSetting> {
  /** When a visit last verified, and as whom. In memory: a restart waits for the next one. */
  lastVisit(): { at: Date; email: string } | null;
}

const LOG_EVERY_MS = 60_000;

/** The single assertion header, or nothing: two header lines are not one assertion. */
function assertionOf(req: IncomingMessage): string | undefined | null {
  const raw = req.headers[CF_ASSERTION_HEADER];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return null;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function connectingIp(req: IncomingMessage): string {
  const raw = req.headers['cf-connecting-ip'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  // Only ever a bucket name, but kept to the shape of an address.
  return /^[0-9A-Fa-f:.]{2,45}$/.test(value) ? value.toLowerCase() : 'unknown';
}

export function cloudflareProvider(deps: CloudflareProviderDeps): CloudflareProvider {
  const lastLogged = new Map<CloudflareRefusal, number>();
  let visit: { at: Date; email: string } | null = null;
  const complain = (reason: CloudflareRefusal, now: Date): { ok: false } & AccessRefusal => {
    const last = lastLogged.get(reason) ?? 0;
    if (now.getTime() - last >= LOG_EVERY_MS) {
      lastLogged.set(reason, now.getTime());
      (deps.log ?? ((line: string) => console.error(line)))(`access: cloudflare: ${REASONS[reason]}`);
    }
    return { ok: false, ...refusalOf(reason) };
  };

  const identify = async (req: IncomingMessage, setting: CloudflareAccessSetting, now: Date): Promise<AccessIdentifyResult | null> => {
    const token = assertionOf(req);
    if (arrivalOf(req) !== 'ingress') {
      // Only a request that claims something is worth a word in the log.
      return token === undefined ? null : complain('not-through-the-tunnel', now);
    }
    if (!setting.enabled) return complain('setting-off', now);
    if (token === undefined) return complain('no-assertion', now);
    // An assertion presented that does not verify is a failed sign-in, counted
    // per Cf-Connecting-Ip; keys that could not be fetched are not an answer.
    const attempt = (raw: string) => ({ bucket: `cf:${connectingIp(req)}`, credential: createHash('sha256').update(`cf-assertion:${raw}`).digest('base64url') });
    if (token === null) {
      const raw = req.headers[CF_ASSERTION_HEADER];
      return { ...complain('malformed', now), attempt: attempt(Array.isArray(raw) ? raw.join('\n') : String(raw)) };
    }
    const verified = await verifyAccessJwt(token, setting, { jwks: deps.jwks, now });
    if (!verified.ok) {
      const refused = complain(verified.reason, now);
      return verified.reason === 'keys-unreachable' ? refused : { ...refused, attempt: attempt(token) };
    }
    visit = { at: now, email: verified.assertion.email };
    return {
      ok: true,
      identity: {
        provider: 'cloudflare-access',
        subject: verified.assertion.email,
        name: verified.assertion.email,
        detail: { team: setting.teamDomain },
        bucket: `cf:${connectingIp(req)}`,
        expiresAt: verified.assertion.expiresAt,
      },
    };
  };

  return {
    id: 'cloudflare-access',
    title: 'Cloudflare Access',
    identity: 'login',
    proxy: 'this-machine',
    arrival: 'ingress',
    settingKey: CLOUDFLARE_SETTING_KEY,
    absoluteCapMs: CLOUDFLARE_ABSOLUTE_CAP_MS,
    parseSetting: toCloudflareSetting,
    enabled: (setting) => setting.enabled,
    allowed: (setting) => setting.email,
    lastVisit: () => visit,
    async status(setting): Promise<AccessStatus> {
      // Off is off, however much of the form is filled in: what is missing
      // is the panel's neutral line until the owner tries to turn it on.
      if (!setting.enabled) return { state: 'off', sentence: 'Off. Your own domain, with Cloudflare’s sign-in in front of it.' };
      const problem = deps.ingressProblem?.() ?? null;
      if (problem) return { state: 'needs-setup', sentence: problem };
      if (deps.jwks.failing(setting.teamDomain)) {
        return { state: 'unanswered', sentence: 'Cloudflare’s signing keys couldn’t be fetched just now. Visits wait until they can.' };
      }
      if (!visit) return { state: 'waiting', sentence: 'Waiting for a first visit through Cloudflare.' };
      const host = setting.publicOrigin ? new URL(setting.publicOrigin).host : setting.teamDomain;
      return { state: 'ready', sentence: `Ready at ${host}, for ${setting.email}` };
    },
    setup(_setting, ctx: AccessContext): AccessSetup {
      const port = ctx.ingressPort() ?? ctx.dashboardPort() + 2;
      return {
        steps: [
          { text: 'Install cloudflared on this computer. On Linux, use the .deb from Cloudflare or its package repository.', command: 'brew install cloudflared' },
          { text: 'In Cloudflare’s dashboard: Zero Trust → Networks → Tunnels → Create a tunnel. Run the cloudflared service install … line it shows.' },
          { text: 'Add a public hostname, like buddi.example.com, with this service. Not the dashboard’s port: everything on this one counts as a visit from elsewhere.', command: `http://127.0.0.1:${port}` },
          { text: 'Zero Trust → Access → Applications → Add a self-hosted application for that hostname. Policy: Allow, Include → Emails → your email.' },
          { text: 'Copy the team domain and the application’s AUD tag here.' },
        ],
        fields: [
          { key: 'teamDomain', label: 'Team domain', placeholder: 'yourteam.cloudflareaccess.com' },
          { key: 'aud', label: 'Application AUD tag', placeholder: '64 letters and digits' },
          { key: 'email', label: 'Your email', hint: 'The one your Access policy allows.', placeholder: 'you@example.com' },
          { key: 'publicOrigin', label: 'Public address', hint: 'So cookies and the Origin check use it.', placeholder: 'https://buddi.example.com' },
        ],
      };
    },
    // Everything on the ingress listener is this provider's: cloudflared
    // points there, and nothing else does.
    matches: (req) => arrivalOf(req) === 'ingress',
    identify,
    async confirm(session, req, setting, now): Promise<AccessConfirmation> {
      if (!setting.enabled) return { answer: 'end', refusal: refusalOf('setting-off') };
      if (!sameSubject(session.providerSubject, setting.email)) return { answer: 'end', refusal: refusalOf('email-not-allowed') };
      const result = await identify(req, setting, now);
      if (result?.ok) {
        // The same email it was minted for, or the session goes.
        return sameSubject(result.identity.subject, session.providerSubject) ? { answer: 'keep' } : { answer: 'end' };
      }
      if (result && result.kind === 'unanswered') return { answer: 'unanswered', refusal: result };
      if (result && result.kind === 'login') return { answer: 'end', refusal: result };
      // A missing or failed assertion ends this request, not the session: a
      // stray request without the header cannot sign the owner out.
      return { answer: 'refuse', refusal: result ?? refusalOf('no-assertion') };
    },
    clientKey: () => 'cf:unverified',
  };
}
