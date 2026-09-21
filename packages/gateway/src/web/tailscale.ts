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
 * identity is honoured only when all of these hold:
 *
 *   1. The owner turned this on and named the login that may sign in. Off by
 *      default; nothing about having Tailscale installed widens access.
 *   2. The socket's remote address is loopback. The proxy is a local process,
 *      so a request that arrives from the network — headers and all — is a
 *      stranger spelling the headers themselves, and is refused.
 *   3. `X-Forwarded-For` names exactly one address. Serve *overwrites* that
 *      header; a second proxy in front of it appends instead, so a list is
 *      proof that something other than Serve handled this request.
 *   4. That address is a tailnet address (`100.64.0.0/10` or
 *      `fd7a:115c:a1e0::/48`), and `X-Forwarded-Proto` is `https` — Serve
 *      terminates TLS and says so. Anything else did not come through it.
 *   5. The local `tailscaled` confirms, through its own API over its unix
 *      socket, that the address belongs to the allowed login, and that the
 *      login the header claimed is the very one the daemon names. This is the
 *      step the headers cannot fake: the answer comes from the daemon.
 *
 * Anything short of that is no identity at all, and the request carries on
 * unauthenticated — a 401, exactly as before. The reason is logged by a fixed
 * name, once a minute at most and never with a supplied login or address in
 * it, so a misconfigured proxy says so without filling the log or letting a
 * caller choose what goes in it.
 *
 * ## What this does not prove, said plainly
 *
 * The gateway sees a loopback connection carrying headers. It cannot tell
 * `tailscale serve` from any other process on the same machine that opens the
 * same port and spells the same headers: the daemon confirms that the
 * *claimed* address belongs to the allowed login, not that the request came
 * from that address. So this feature extends to the tailnet the trust the
 * loopback dashboard already gives this machine — no more, and no less. That
 * is a small step, because a process that can reach the loopback port could
 * already read the data directory, the `.env` and the keychain, and therefore
 * already had everything a session would have given it. It is worth saying out
 * loud all the same: turning this on does not make the machine's own processes
 * less trusted than they were, and it does not make them more trusted either.
 * The session it mints is bound (see `sessions.ts`): the daemon is asked again
 * on every request, and the setting going off or naming another login ends it.
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
  /**
   * The caller's sign-in budget, asked immediately before the daemon is. False
   * means "over budget": no whois is made and the request earns no identity.
   */
  mayAskDaemon?: (() => boolean) | undefined;
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

/**
 * The one address `X-Forwarded-For` names, or nothing.
 *
 * Serve overwrites this header with the tailnet address it is forwarding for,
 * so a single value is what an unmediated Serve hop looks like. Every other
 * proxy *appends*, which is why a list — or a repeated header line — is not
 * read as "the first one is the client" but as "something else is in the
 * path", and earns no identity at all.
 */
export function forwardedAddress(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-forwarded-for'];
  // Two header lines are two hops as surely as one line with a comma in it.
  if (Array.isArray(raw)) return undefined;
  if (typeof raw !== 'string' || raw.includes(',')) return undefined;
  const address = normalize(raw);
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

/**
 * Why a request earned no identity — the whole vocabulary of it.
 *
 * Every refusal is one of these, and the log says the name and nothing else.
 * The supplied login and the claimed address are exactly the parts a caller
 * chooses, so they are never the key of the throttle map and never a word in
 * the line: a caller varying a header cannot mint an unbounded number of
 * entries, nor write into a log only the owner reads.
 */
export type TailscaleRefusal =
  | 'setting-off'
  | 'not-this-machine'
  | 'forwarded-more-than-once'
  | 'not-a-tailnet-address'
  | 'not-forwarded-over-https'
  | 'login-not-allowed'
  | 'too-many-attempts'
  | 'daemon-unreachable'
  | 'daemon-does-not-know'
  | 'daemon-names-another-login';

const REASONS: Readonly<Record<TailscaleRefusal, string>> = {
  'setting-off': 'a request carried Tailscale identity headers but signing in through Tailscale is off',
  'not-this-machine': 'Tailscale identity headers arrived from an address that is not this machine',
  'forwarded-more-than-once': 'the request was forwarded more than once, so it did not come straight from tailscale serve',
  'not-a-tailnet-address': 'the forwarded address is not a tailnet address',
  'not-forwarded-over-https': 'the request was not forwarded over HTTPS',
  'login-not-allowed': 'the forwarded login is not the login allowed to sign in through Tailscale',
  'too-many-attempts': 'too many failed sign-ins from here to ask the local tailscaled again yet',
  'daemon-unreachable': 'the local tailscaled could not be asked about the forwarded address',
  'daemon-does-not-know': 'the local tailscaled does not know the forwarded address',
  'daemon-names-another-login': 'the local tailscaled names a different login for the forwarded address',
};

/**
 * When each reason was last said. Bounded by construction — the keys are the
 * enum above and there is no way to add another — and cleared wholesale if it
 * ever somehow exceeds that, so this map cannot grow with traffic.
 */
const lastLogged = new Map<TailscaleRefusal, number>();

function complain(deps: TailscaleIdentityDeps, reason: TailscaleRefusal, at: number): null {
  const last = lastLogged.get(reason) ?? 0;
  if (at - last < LOG_EVERY_MS) return null;
  if (lastLogged.size > Object.keys(REASONS).length) lastLogged.clear();
  lastLogged.set(reason, at);
  (deps.log ?? ((line: string) => console.error(line)))(`tailscale: ${REASONS[reason]}`);
  return null;
}

/** Test seam: forget what has been said, so a suite can assert on the throttle. */
export function resetTailscaleLog(): void {
  lastLogged.clear();
}

/** Test seam: how many reasons the throttle map is holding. */
export function tailscaleLogSize(): number {
  return lastLogged.size;
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
  if (!setting?.enabled || !setting.login.trim()) return complain(deps, 'setting-off', at);
  // The proxy is a process on this machine. A request that arrives from
  // anywhere else and spells these headers is a stranger, not Serve.
  if (!isLoopbackAddress(req.socket.remoteAddress)) return complain(deps, 'not-this-machine', at);
  // A list, or a second header line, means a proxy that appends — not Serve,
  // which overwrites. See `forwardedAddress`.
  if (req.headers['x-forwarded-for'] !== undefined && forwardedAddress(req) === undefined) {
    return complain(deps, 'forwarded-more-than-once', at);
  }
  const address = forwardedAddress(req);
  if (!isTailnetAddress(address)) return complain(deps, 'not-a-tailnet-address', at);
  // Serve terminates TLS for the tailnet and says so on the way through.
  if ((header(req, 'x-forwarded-proto') ?? '').toLowerCase() !== 'https') {
    return complain(deps, 'not-forwarded-over-https', at);
  }
  if (!sameLogin(login, setting.login)) return complain(deps, 'login-not-allowed', at);

  /*
   * Only now is the daemon asked.
   *
   * Everything above is a string comparison this process makes to itself. The
   * whois is a round trip to `tailscaled` over its socket, so it sits behind
   * the same per-caller sign-in budget the 401 below consumes: a caller
   * varying a header to miss the one-minute whois cache cannot turn the
   * gateway into a load generator pointed at the daemon.
   */
  if (deps.mayAskDaemon && !deps.mayAskDaemon()) return complain(deps, 'too-many-attempts', at);

  let profile: TailscaleProfile | null;
  try {
    profile = await deps.whois(address as string);
  } catch {
    return complain(deps, 'daemon-unreachable', at);
  }
  if (!profile) return complain(deps, 'daemon-does-not-know', at);
  // The daemon's answer is the credential; the header only said what to check.
  // Both have to agree with the setting *and* with each other, so a header
  // naming one person for an address the daemon gives another earns nothing.
  if (!sameLogin(profile.login, setting.login)) return complain(deps, 'daemon-names-another-login', at);
  if (!sameLogin(login, profile.login)) return complain(deps, 'daemon-names-another-login', at);
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
