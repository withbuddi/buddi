/**
 * The address rules for reaching the web: what a URL may name before a socket
 * exists.
 *
 * Moved here from `@buddi/tool-web`'s `guard.ts` (docs/plugin-host-api.md
 * §3) so a plugin can check a URL without importing another plugin: the browser
 * plugin was the first. Pure — a URL in, a verdict out, nothing resolved. The
 * half that resolves, `guardedLookup`, does I/O and lives with the `http` area
 * in `host/http.ts`, where every request a plugin sends goes through both.
 *
 * Why the rules are what they are is written at the top of `host/http.ts`.
 */
import { isIP } from 'node:net';

/** A destination this plugin refuses to reach, and the sentence saying why. */
export class BlockedError extends Error {
  override readonly name = 'BlockedError';
  readonly code = 'blocked-destination';
  /** Short, stable, loggable: `private-address`, `scheme`, `port`, … */
  readonly reason: BlockReason;
  constructor(reason: BlockReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type BlockReason =
  | 'scheme'
  | 'port'
  | 'credentials'
  | 'hostname'
  | 'private-address'
  | 'unresolvable';

/** The only two schemes. Everything else — `file:`, `ftp:`, `data:`, `gopher:`,
 * `javascript:` — is refused by name rather than by omission. */
export const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:'];

/**
 * The only ports.
 *
 * A deliberately blunt instrument, and it is the first thing that stops
 * `127.0.0.1:4317` and `127.0.0.1:55433` — before DNS, before anything. The web
 * this plugin is for lives on 80 and 443; a page that does not is a page the
 * owner can fetch himself. Widening this list widens the blast radius of every
 * other bug in the file, so it is a constant and not a setting.
 */
export const ALLOWED_PORTS: readonly number[] = [80, 443];

/**
 * Hostnames refused on sight, before any resolution.
 *
 * Belt and braces: each of these normally resolves to something the address
 * rules would reject anyway. `metadata.google.internal` is the exception that
 * justifies the list — on GCE it resolves to 169.254.169.254, but a resolver
 * that answered it differently would still be answering for the metadata
 * service, and the name alone is enough to refuse.
 */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
  '.localdomain',
];

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  return BLOCKED_HOST_SUFFIXES.some((s) =>
    s.startsWith('.') ? host.endsWith(s) : host === s,
  );
}

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

/** `a.b.c.d` -> a 32-bit number, or `null` when it is not dotted-quad. */
function v4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/** One CIDR block and the one line saying what it is. */
interface Block {
  base: number;
  bits: number;
  what: string;
}

function cidr(notation: string, what: string): Block {
  const [address, bitsText] = notation.split('/');
  const base = v4ToInt(address ?? '');
  if (base === null) throw new Error(`bad CIDR in the block list: ${notation}`);
  return { base, bits: Number(bitsText), what };
}

/**
 * Every IPv4 range this plugin will not dial.
 *
 * Not "the private ones": *every* range that is not a host on the public
 * internet. Carrier-grade NAT is where a cloud metadata service hides on
 * Alibaba; 198.18/15 is the benchmarking range; 240/4 is reserved and a fine
 * way to confuse a stack. The cost of refusing a range nobody needed is zero.
 */
const V4_BLOCKS: readonly Block[] = [
  cidr('0.0.0.0/8', 'this network'),
  cidr('10.0.0.0/8', 'a private network'),
  cidr('100.64.0.0/10', 'carrier-grade NAT (and some cloud metadata services)'),
  cidr('127.0.0.0/8', 'this machine (loopback) — the dashboard and the database live here'),
  cidr('169.254.0.0/16', 'link-local, which is where cloud metadata endpoints live'),
  cidr('172.16.0.0/12', 'a private network'),
  cidr('192.0.0.0/24', 'IETF protocol assignments'),
  cidr('192.0.2.0/24', 'documentation (TEST-NET-1)'),
  cidr('192.168.0.0/16', 'a private network — the LAN this machine is on'),
  cidr('198.18.0.0/15', 'benchmarking'),
  cidr('198.51.100.0/24', 'documentation (TEST-NET-2)'),
  cidr('203.0.113.0/24', 'documentation (TEST-NET-3)'),
  cidr('224.0.0.0/4', 'multicast'),
  cidr('240.0.0.0/4', 'reserved, including the broadcast address'),
];

/** Why this IPv4 address is refused, or `null` when it is an ordinary host. */
export function blockedV4(address: string): string | null {
  const value = v4ToInt(address);
  if (value === null) return 'not a usable IPv4 address';
  for (const block of V4_BLOCKS) {
    const mask = block.bits === 0 ? 0 : (0xffffffff << (32 - block.bits)) >>> 0;
    if ((value & mask) >>> 0 === block.base) return block.what;
  }
  return null;
}

/** Expand an IPv6 address to its eight 16-bit groups. `null` if unparseable. */
function v6Groups(address: string): number[] | null {
  let text = address.trim().toLowerCase();
  // A zone index (`fe80::1%en0`) is not part of the address, and its presence
  // is itself a link-local tell.
  const percent = text.indexOf('%');
  if (percent !== -1) text = text.slice(0, percent);
  // An embedded IPv4 tail (`::ffff:127.0.0.1`) becomes two groups.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const value = v4ToInt(dotted[1] as string);
    if (value === null) return null;
    text = `${text.slice(0, dotted.index)}:${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/** Why this IPv6 address is refused, or `null` when it is an ordinary host. */
export function blockedV6(address: string): string | null {
  const g = v6Groups(address);
  if (g === null) return 'not a usable IPv6 address';
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, gg = 0, h = 0] = g;
  const allZero = g.every((x) => x === 0);
  if (allZero) return 'the unspecified address';
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && gg === 0 && h === 1) {
    return 'this machine (loopback) — the dashboard and the database live here';
  }
  // IPv4-mapped (`::ffff:127.0.0.1`) and IPv4-compatible: the v4 rules decide,
  // because the packet ends up at that v4 address.
  const embedded = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return blockedV4(embedded(gg, h)) ?? null;
  }
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && (gg !== 0 || h !== 0)) {
    return blockedV4(embedded(gg, h)) ?? 'an IPv4-compatible IPv6 address';
  }
  // 64:ff9b::/96 — NAT64, which is a v4 destination wearing a v6 hat.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return blockedV4(embedded(gg, h)) ?? null;
  }
  // 2002::/16 — 6to4 carries the v4 address in the next two groups.
  if (a === 0x2002) return blockedV4(embedded(b, c)) ?? null;
  if ((a & 0xffc0) === 0xfe80) return 'link-local';
  if ((a & 0xfe00) === 0xfc00) return 'a unique-local (private) network';
  if ((a & 0xff00) === 0xff00) return 'multicast';
  if ((a & 0xffc0) === 0xfec0) return 'site-local (deprecated private)';
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return 'the discard prefix';
  if (a === 0x2001 && b === 0x0db8) return 'documentation';
  return null;
}

/**
 * Why this address is refused, or `null` when it is an ordinary public host.
 * The one function every other check in this file goes through.
 */
export function blockedAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return blockedV4(address);
  if (family === 6) return blockedV6(address);
  return 'not an IP address';
}

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

/**
 * The rules, as an object, so that a test can stand up a fixture server on
 * `127.0.0.1` and still exercise the fetching code.
 *
 * This is parameterisation, not a back door. `DEFAULT_POLICY` is the only
 * policy any shipped code constructs — the manifest hard-wires it — and there
 * is no environment variable, no tool argument and no setting that widens it.
 * A test that wants to reach loopback writes its own permissive policy *in the
 * test file*, exactly as the email suite writes its own SMTP sink, and the
 * blocking tests below run against `DEFAULT_POLICY` itself.
 */
export interface AddressPolicy {
  /** The ports a URL may name. */
  ports: readonly number[];
  /** Why this address is refused, or `null` when it is allowed. */
  blocked(address: string): string | null;
  /** Is this hostname refused before anything is resolved? */
  blockedHostname(hostname: string): boolean;
}

export const DEFAULT_POLICY: AddressPolicy = {
  ports: ALLOWED_PORTS,
  blocked: blockedAddress,
  blockedHostname: isBlockedHostname,
};

export interface CheckedUrl {
  url: URL;
  /** The host with no port and no brackets, as DNS would be asked for it. */
  hostname: string;
  /** Set when the host is already an IP literal: there is nothing to resolve. */
  literalAddress: string | null;
}

/**
 * Everything decidable from the URL alone. Throws `BlockedError`.
 *
 * This runs before a socket exists, and it is *not* the whole check — the
 * address rules run again inside `guardedLookup`, on whatever DNS actually
 * answers. Two layers on purpose: this one gives a good error message for the
 * common case, that one is the guarantee.
 */
export function checkUrl(raw: string, policy: AddressPolicy = DEFAULT_POLICY): CheckedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedError('scheme', `that is not a URL: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) {
    throw new BlockedError(
      'scheme',
      `refusing ${url.protocol} — this tool reads web pages over http and https only, and never reads the local filesystem`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new BlockedError(
      'credentials',
      'refusing a URL that carries a username or password in it',
    );
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!policy.ports.includes(port)) {
    throw new BlockedError(
      'port',
      `refusing port ${port} — only the web's own ports (80 and 443) are reachable, so local services like the dashboard and the database cannot be fetched`,
    );
  }
  // `new URL` keeps IPv6 literals in brackets; DNS and the block list do not.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (policy.blockedHostname(hostname)) {
    throw new BlockedError('hostname', `refusing the hostname "${hostname}" — it names this machine or its local network`);
  }
  if (isIP(hostname) !== 0) {
    const why = policy.blocked(hostname);
    if (why !== null) {
      throw new BlockedError('private-address', `refusing ${hostname} — ${why}`);
    }
    return { url, hostname, literalAddress: hostname };
  }
  return { url, hostname, literalAddress: null };
}
