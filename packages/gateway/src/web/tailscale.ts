/**
 * Signing in through Tailscale.
 *
 * When the dashboard is published on the tailnet with `tailscale serve`, the
 * proxy runs *on this machine* and forwards every request to the gateway with
 * three headers describing who is on the other end (`Tailscale-User-Login`,
 * `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`) and an
 * `X-Forwarded-For` carrying the tailnet address of the device.
 *
 * Headers are not a credential, and this module never treats them as one. An
 * identity is honoured only when all four of these hold:
 *
 *   1. The owner turned this on and named the login that may sign in. Off by
 *      default; nothing about having Tailscale installed widens access.
 *   2. The socket's remote address is loopback. The proxy is a local process,
 *      so a request that arrives from the network — headers and all — is a
 *      stranger spelling the headers themselves, and is refused.
 *   3. `X-Forwarded-For` is a tailnet address (`100.64.0.0/10` or
 *      `fd7a:115c:a1e0::/48`). Anything else did not come through Serve.
 *   4. The local `tailscaled` confirms, through its own API over its unix
 *      socket, that the address belongs to that login. This is the step the
 *      headers cannot fake: the answer comes from the daemon, not the request.
 *
 * Anything short of that is no identity at all, and the request carries on
 * unauthenticated — a 401, exactly as before. The reason is logged once a
 * minute at most, so a misconfigured proxy says so without filling the log.
 */
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from './http.js';

/** The key this setting is stored under in `core.web_settings`. */
export const TAILSCALE_SETTING_KEY = 'tailscale';

/** Where `tailscaled` listens, on both platforms buddi runs on. */
export const TAILSCALED_SOCKET = '/var/run/tailscale/tailscaled.sock';

/** The host name the local API insists on. Not a network name; never resolved. */
const LOCAL_API_HOST = 'local-tailscaled.sock';

/** How long a whois answer is reused. Long enough for a page load, short enough to matter. */
export const WHOIS_CACHE_MS = 60_000;

/** At most one line per reason per minute. */
const LOG_EVERY_MS = 60_000;

export interface TailscaleSetting {
  enabled: boolean;
  login: string;
}

/** Who the daemon says is behind an address, or behind this machine. */
export interface TailscaleProfile {
  login: string;
  name: string;
}

export interface TailscaleIdentity extends TailscaleProfile {
  /** The tailnet address the request was forwarded from. */
  address: string;
}

/** A whois, injected so tests never need a daemon. Null means "cannot say". */
export type TailscaleWhois = (address: string) => Promise<TailscaleProfile | null>;

export interface TailscaleIdentityDeps {
  /** The stored setting. Asked only once the headers are actually present. */
  setting: () => Promise<TailscaleSetting | null>;
  whois: TailscaleWhois;
  log?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
}

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

/**
 * Is this one of Tailscale's own addresses?
 *
 * `100.64.0.0/10` is the CGNAT range Tailscale hands out, and
 * `fd7a:115c:a1e0::/48` is its ULA prefix. Nothing else counts: a
 * `X-Forwarded-For` naming a LAN address is a different proxy, and a public
 * one is a request that has been out on the internet.
 */
export function isTailnetAddress(address: string | undefined): boolean {
  const a = normalize(address);
  if (a === '') return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n > 255)) return false;
    return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  }
  return a.startsWith('fd7a:115c:a1e0:') || a === 'fd7a:115c:a1e0::';
}

function normalize(address: string | undefined): string {
  if (!address) return '';
  let a = address.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  // A bracketless `host:port` is only ever IPv4 here; IPv6 keeps its colons.
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  return a;
}

/** The first hop of `X-Forwarded-For`: the client the nearest proxy saw. */
export function forwardedAddress(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const first = value.split(',')[0];
  const address = normalize(first);
  return address === '' ? undefined : address;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Did this request come through a local Tailscale proxy?
 *
 * Only ever used to *narrow* what the page offers — the panel disables itself
 * when the answer is yes — never to grant anything.
 */
export function proxiedThroughTailscale(req: IncomingMessage): boolean {
  return (
    header(req, 'tailscale-user-login') !== undefined &&
    isLoopbackAddress(req.socket.remoteAddress) &&
    isTailnetAddress(forwardedAddress(req))
  );
}

/** Two logins are the same person when they differ only in case. */
export function sameLogin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Is this a login one could plausibly have on a tailnet?
 *
 * Tailscale logins are usually an email, sometimes `user@github` or a bare
 * name for a tailnet with its own identity provider. Checked for shape, never
 * for existence: the daemon is what decides whether a login is real.
 */
export function plausibleLogin(login: string): boolean {
  const value = login.trim();
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  if (value.includes('@')) return /^[^@\s]+@[^@\s]+$/.test(value);
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
}

/* ------------------------------------------------------------------ *
 * The identity
 * ------------------------------------------------------------------ */

const lastLogged = new Map<string, number>();

function complain(deps: TailscaleIdentityDeps, reason: string, at: number): void {
  const last = lastLogged.get(reason) ?? 0;
  if (at - last < LOG_EVERY_MS) return;
  lastLogged.set(reason, at);
  (deps.log ?? ((line: string) => console.error(line)))(`tailscale: ${reason}`);
}

/** Test seam: forget what has been said, so a suite can assert on the throttle. */
export function resetTailscaleLog(): void {
  lastLogged.clear();
}

/**
 * Who this request is, according to Tailscale — or null, which means the
 * request is simply unauthenticated and the ordinary gate answers it.
 */
export async function tailscaleIdentity(
  req: IncomingMessage,
  deps: TailscaleIdentityDeps,
): Promise<TailscaleIdentity | null> {
  const login = header(req, 'tailscale-user-login');
  if (login === undefined) return null;
  const at = (deps.now ?? (() => new Date()))().getTime();

  const setting = await deps.setting();
  if (!setting?.enabled || !setting.login.trim()) {
    complain(deps, 'a request carried Tailscale identity headers but signing in through Tailscale is off', at);
    return null;
  }
  // The proxy is a process on this machine. A request that arrives from
  // anywhere else and spells these headers is a stranger, not Serve.
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    complain(deps, `Tailscale identity headers arrived from ${req.socket.remoteAddress ?? 'an unknown address'}, which is not this machine`, at);
    return null;
  }
  const address = forwardedAddress(req);
  if (!isTailnetAddress(address)) {
    complain(deps, `the forwarded address ${address ?? '(none)'} is not a tailnet address`, at);
    return null;
  }
  if (!sameLogin(login, setting.login)) {
    complain(deps, `${login} is not the login allowed to sign in through Tailscale`, at);
    return null;
  }

  let profile: TailscaleProfile | null;
  try {
    profile = await deps.whois(address as string);
  } catch (err) {
    complain(deps, `the local tailscaled could not be asked about ${address}: ${err instanceof Error ? err.message : String(err)}`, at);
    return null;
  }
  if (!profile) {
    complain(deps, `the local tailscaled does not know ${address}`, at);
    return null;
  }
  // The daemon's answer is the credential; the header only said what to check.
  if (!sameLogin(profile.login, setting.login)) {
    complain(deps, `tailscaled says ${address} is ${profile.login}, not the allowed login`, at);
    return null;
  }
  return {
    login: profile.login,
    name: header(req, 'tailscale-user-name') ?? profile.name ?? profile.login,
    address: address as string,
  };
}

/* ------------------------------------------------------------------ *
 * The local daemon
 * ------------------------------------------------------------------ */

/**
 * One GET against `tailscaled`'s local API.
 *
 * `fetch` cannot address a unix socket, so this is `node:http`'s client with
 * `socketPath` — the same shape `service.ts` uses for the supervisor. Nothing
 * here ever leaves the machine.
 */
export function localApiGet(route: string, socketPath = TAILSCALED_SOCKET, timeoutMs = 3_000): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: route, method: 'GET', headers: { host: LOCAL_API_HOST }, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (text.length < 256_000) text += chunk; });
      res.on('end', () => {
        let body: unknown = null;
        try { body = text === '' ? null : JSON.parse(text); } catch { return reject(new Error('tailscaled answered with something that is not JSON')); }
        resolve({ status: res.statusCode ?? 502, body });
      });
    });
    req.once('timeout', () => req.destroy(new Error('tailscaled did not answer in time')));
    req.once('error', reject);
    req.end();
  });
}

function profileOf(value: unknown): TailscaleProfile | null {
  const profile = (value as { UserProfile?: { LoginName?: unknown; DisplayName?: unknown } } | null)?.UserProfile;
  const login = typeof profile?.LoginName === 'string' ? profile.LoginName : '';
  if (login === '') return null;
  return { login, name: typeof profile?.DisplayName === 'string' && profile.DisplayName !== '' ? profile.DisplayName : login };
}

/**
 * A whois against the local daemon, with a one-minute memory.
 *
 * The cache is per gateway process and keyed by address. A minute is short
 * enough that removing a device from the tailnet takes effect while the owner
 * is still looking at the screen, and long enough that a page of a dozen
 * requests asks the daemon once.
 */
export function daemonWhois(socketPath = TAILSCALED_SOCKET, now: () => Date = () => new Date()): TailscaleWhois {
  const cache = new Map<string, { at: number; profile: TailscaleProfile | null }>();
  return async (address: string) => {
    const at = now().getTime();
    const hit = cache.get(address);
    if (hit && at - hit.at < WHOIS_CACHE_MS) return hit.profile;
    const answer = await localApiGet(`/localapi/v0/whois?addr=${encodeURIComponent(address)}`, socketPath);
    const profile = answer.status === 200 ? profileOf(answer.body) : null;
    cache.set(address, { at, profile });
    return profile;
  };
}

/** Is `tailscaled` running here, and who is this machine signed in as? */
export async function tailscaleSelf(socketPath = TAILSCALED_SOCKET): Promise<{ available: boolean; self: TailscaleProfile | null }> {
  try {
    const answer = await localApiGet('/localapi/v0/status', socketPath);
    if (answer.status !== 200) return { available: false, self: null };
    return { available: true, self: profileOf((answer.body as { Self?: unknown } | null)?.Self) };
  } catch {
    return { available: false, self: null };
  }
}

/** What is stored, made safe: anything unexpected in the row reads as "off". */
export function toTailscaleSetting(value: unknown): TailscaleSetting {
  const row = (value ?? {}) as { enabled?: unknown; login?: unknown };
  const login = typeof row.login === 'string' ? row.login.trim() : '';
  return { enabled: row.enabled === true && login !== '', login };
}
