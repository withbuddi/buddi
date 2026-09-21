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
 *   5. The local daemon confirms, through the `tailscale` CLI (or its unix
 *      socket, when there is no binary to run), that the address belongs to the allowed login, and that the
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
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { delimiter, isAbsolute, join } from 'node:path';
import { isLoopbackAddress } from './http.js';

/** The key this setting is stored under in `core.web_settings`. */
export const TAILSCALE_SETTING_KEY = 'tailscale';

/**
 * Where the open-source `tailscaled` listens. The macOS app does not open it,
 * which is why the `tailscale` CLI — which knows how to reach its own daemon
 * whichever variant is installed — is asked first and this is the fallback.
 */
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
 * Where a `tailscale` binary lives when it is not on the PATH.
 *
 * The Homebrew/open-source install puts it in `/usr/local/bin`; the Mac App
 * Store app ships its own copy inside the bundle. Tried in this order, after
 * the PATH, so a deliberately installed binary always wins.
 */
export const TAILSCALE_FALLBACK_BINARIES: readonly string[] = [
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

/** How long the CLI is given to answer before it is killed. */
export const TAILSCALE_TIMEOUT_MS = 5_000;

/** Enough for a large `status --json`; anything past it is not an answer. */
const MAX_OUTPUT = 4_000_000;

export interface BinaryLookup {
  /** The PATH to search. Defaults to this process's. */
  path?: string | undefined;
  /** Is this an executable file? Defaults to a real `access(X_OK)`. */
  canExec?: ((path: string) => boolean) | undefined;
}

/**
 * The `tailscale` binary to talk to the daemon through, or null.
 *
 * The CLI knows how to reach its own daemon on every variant — the unix
 * socket of the open-source `tailscaled`, and the port-and-token the macOS app
 * uses instead — which is precisely why it, and not a hard-coded socket path,
 * is what this module asks. Only absolute PATH entries are considered: a
 * relative one would resolve against whatever directory the gateway happens to
 * be running in.
 */
export function resolveTailscaleBinary(look: BinaryLookup = {}): string | null {
  const canExec = look.canExec ?? defaultCanExec;
  const path = look.path ?? process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'tailscale');
    if (canExec(candidate)) return candidate;
  }
  for (const candidate of TAILSCALE_FALLBACK_BINARIES) {
    if (canExec(candidate)) return candidate;
  }
  return null;
}

function defaultCanExec(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Running the CLI, injected so tests never spawn anything. */
export type TailscaleExec = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/**
 * One `tailscale` invocation.
 *
 * `execFile`, so there is no shell and no word of the argv is ever parsed by
 * one; a five second timeout, so a wedged daemon cannot hold a request open.
 * A non-zero exit is an answer ("does not know"), not a crash.
 */
export const execTailscale: TailscaleExec = (binary, args) =>
  new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: TAILSCALE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, shell: false, windowsHide: true },
      (error, stdout) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') });
      },
    );
  });

/**
 * Is this a literal IP address?
 *
 * The address comes off a request header, and it is about to become an
 * argument to a program. `execFile` already means no shell parses it, and this
 * means nothing that is not an address gets that far in the first place: a
 * flag, a path, an option-looking string — none of them are IPs, so none of
 * them are ever spelled into an argv.
 */
export function isIpAddress(address: string): boolean {
  const a = address.trim();
  if (a === '' || a.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) {
    return a.split('.').every((part) => part.length <= 3 && Number(part) <= 255);
  }
  // IPv6: hex groups and at most one `::`, no zone and no embedded IPv4 —
  // tailnet addresses are plain, and anything exotic simply is not asked.
  if (!/^[0-9a-fA-F:]+$/.test(a)) return false;
  if ((a.match(/::/g) ?? []).length > 1) return false;
  if (/:::/.test(a)) return false;
  const groups = a.split(':').filter((g) => g !== '');
  if (groups.length === 0 || groups.length > 8) return false;
  if (!a.includes('::') && a.split(':').length !== 8) return false;
  return groups.every((g) => g.length <= 4);
}

/* ---- Reading what the CLI says ---- */

function profileOf(value: unknown): TailscaleProfile | null {
  const node = value as { UserProfile?: { LoginName?: unknown; DisplayName?: unknown }; Node?: { Name?: unknown } } | null;
  const profile = node?.UserProfile;
  const login = typeof profile?.LoginName === 'string' ? profile.LoginName.trim() : '';
  if (login === '') return null;
  const display = typeof profile?.DisplayName === 'string' && profile.DisplayName.trim() !== '' ? profile.DisplayName.trim() : '';
  const nodeName = typeof node?.Node?.Name === 'string' && node.Node.Name.trim() !== '' ? node.Node.Name.trim() : '';
  return { login, name: display !== '' ? display : nodeName !== '' ? nodeName : login };
}

/** The entry in `status --json`'s `User` map for a user id, if there is one. */
function userOf(body: { User?: unknown }, id: unknown): unknown {
  if (typeof id !== 'number' && typeof id !== 'string') return undefined;
  const users = body.User as Record<string, unknown> | null | undefined;
  if (users === null || typeof users !== 'object') return undefined;
  return users[String(id)];
}

function parsed(text: string): unknown {
  const body = text.trim();
  if (body === '') return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** What `tailscale whois --json <ip>` says about an address, or nothing. */
export function parseWhois(stdout: string): TailscaleProfile | null {
  return profileOf(parsed(stdout));
}

/** What `tailscale status --json` says about this machine. */
export function parseStatus(stdout: string): { running: boolean; self: TailscaleProfile | null; addresses: string[] } {
  const body = parsed(stdout) as { Self?: unknown; BackendState?: unknown; User?: unknown } | null;
  if (body === null || typeof body !== 'object') return { running: false, self: null, addresses: [] };
  const state = typeof body.BackendState === 'string' ? body.BackendState : '';
  // `Running` is signed in and up; `Stopped`/`NeedsLogin` are a daemon that is
  // there but has nothing to say about anyone, which is not an identity source.
  const running = state === 'Running';
  // `status --json` does not inline the profile the way `whois` does: `Self`
  // carries a `UserID` into the top-level `User` map. Both shapes are read,
  // the inline one first, because versions differ on which they emit.
  const self = profileOf(body.Self) ?? profileOf({ UserProfile: userOf(body, (body.Self as { UserID?: unknown } | null)?.UserID), Node: body.Self });
  const ips = (body.Self as { TailscaleIPs?: unknown } | null)?.TailscaleIPs;
  const addresses = Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === 'string') : [];
  return { running, self, addresses };
}

/* ---- The unix socket, kept as the fallback ---- */

/**
 * One GET against `tailscaled`'s local API.
 *
 * Only reached when there is no `tailscale` binary to ask but the socket the
 * open-source daemon opens is there all the same. `fetch` cannot address a
 * unix socket, so this is `node:http`'s client with `socketPath` — the same
 * shape `service.ts` uses for the supervisor. Nothing here ever leaves the
 * machine.
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

/** Everything the two questions below need, all of it injectable. */
export interface TailscaleDaemonDeps {
  /** Which binary to run, or null for "there is none". */
  binary?: (() => string | null) | undefined;
  exec?: TailscaleExec | undefined;
  socketPath?: string | undefined;
  /** Is the socket there? Only asked when there is no binary. */
  socketExists?: ((path: string) => boolean) | undefined;
  api?: ((route: string, socketPath: string) => Promise<{ status: number; body: unknown }>) | undefined;
  now?: (() => Date) | undefined;
}

function binaryOf(deps: TailscaleDaemonDeps): string | null {
  return (deps.binary ?? (() => resolveTailscaleBinary()))();
}

function socketOf(deps: TailscaleDaemonDeps): string | null {
  const path = deps.socketPath ?? TAILSCALED_SOCKET;
  const exists = deps.socketExists ?? ((p: string) => existsSync(p));
  return exists(path) ? path : null;
}

/**
 * Who the daemon says is behind an address — through the CLI, or through the
 * socket when there is no CLI to run.
 */
export async function whoisOnce(address: string, deps: TailscaleDaemonDeps = {}): Promise<TailscaleProfile | null> {
  // Never an argv word that is not an address. See `isIpAddress`.
  if (!isIpAddress(address)) return null;
  const binary = binaryOf(deps);
  if (binary !== null) {
    const res = await (deps.exec ?? execTailscale)(binary, ['whois', '--json', address]);
    if (res.code !== 0) return null;
    return parseWhois(res.stdout);
  }
  const socket = socketOf(deps);
  if (socket === null) throw new Error('no tailscale binary and no tailscaled socket');
  const answer = await (deps.api ?? localApiGet)(`/localapi/v0/whois?addr=${encodeURIComponent(address)}`, socket);
  return answer.status === 200 ? profileOf(answer.body) : null;
}

/**
 * A whois against the local daemon, with a one-minute memory.
 *
 * The cache is per gateway process and keyed by address. A minute is short
 * enough that removing a device from the tailnet takes effect while the owner
 * is still looking at the screen, and long enough that a page of a dozen
 * requests asks the daemon once.
 */
export function daemonWhois(deps: TailscaleDaemonDeps = {}): TailscaleWhois {
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; profile: TailscaleProfile | null }>();
  return async (address: string) => {
    const at = now().getTime();
    const hit = cache.get(address);
    if (hit && at - hit.at < WHOIS_CACHE_MS) return hit.profile;
    const profile = await whoisOnce(address, deps);
    cache.set(address, { at, profile });
    return profile;
  };
}

/** Is Tailscale running here, and who is this machine signed in as? */
export async function tailscaleSelf(deps: TailscaleDaemonDeps = {}): Promise<{ available: boolean; self: TailscaleProfile | null }> {
  const binary = binaryOf(deps);
  if (binary !== null) {
    try {
      const res = await (deps.exec ?? execTailscale)(binary, ['status', '--json']);
      // A daemon that is installed but stopped answers non-zero, and its JSON
      // says so; either way there is nobody to sign in as.
      const status = parseStatus(res.stdout);
      if (!status.running) return { available: false, self: null };
      return { available: true, self: status.self };
    } catch {
      return { available: false, self: null };
    }
  }
  const socket = socketOf(deps);
  if (socket === null) return { available: false, self: null };
  try {
    const answer = await (deps.api ?? localApiGet)('/localapi/v0/status', socket);
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
