/**
 * What this plugin is allowed to dial, and — more importantly — what it is not.
 *
 * ## The thing this file exists to prevent
 *
 * An agent with `web.read` takes a URL from somewhere. Sometimes the owner
 * typed it. Sometimes it came out of a search result, which is to say out of a
 * page a stranger controls, which is to say the stranger chose it. If a URL can
 * name an address inside this machine, then a stranger who can get a URL in
 * front of an agent can read:
 *
 *   - `http://127.0.0.1:4317` — the dashboard, which is the owner's whole
 *     assistant and holds a session token;
 *   - `http://127.0.0.1:55433` — Postgres, which holds his bank data and his
 *     mail;
 *   - `http://169.254.169.254/...` — the cloud metadata endpoint, which on a
 *     hosted box hands out credentials to anyone who asks over plain HTTP with
 *     no authentication whatsoever;
 *   - anything else on the LAN this machine sits on: a router's admin page, a
 *     NAS, a printer.
 *
 * None of that is hypothetical, and none of it needs a bug elsewhere to work.
 * It only needs a fetch that believes the URL.
 *
 * ## Why checking the URL string is not enough
 *
 * Three ways a string check loses, all of which this file covers:
 *
 *  1. **A name resolves wherever its owner says.** `evil.example.com` is a
 *     public hostname, and its A record can be `127.0.0.1`. Nothing about the
 *     URL is suspicious. So the *address* is what must be judged, after DNS.
 *  2. **The answer can change between the check and the connection.** Resolve,
 *     approve, then `connect(hostname)` and the name is resolved a second time
 *     — by the socket, and possibly to a different address. That is DNS
 *     rebinding, and it defeats a resolve-then-check. The fix is not to resolve
 *     twice: `guardedLookup` is handed to the socket as its *own* resolver, so
 *     the address this file approved is the address dialled. There is no second
 *     resolution to poison.
 *  3. **A redirect is a second URL nobody checked.** `http://public.example/x`
 *     answering `302 -> http://127.0.0.1:4317` is a public URL that reaches the
 *     dashboard. So redirects are followed by hand, one hop at a time, and
 *     every hop goes through the whole of this file again. See `http.ts`.
 *
 * ## The rule
 *
 * Deny by default on the address, allow by exception on the scheme and the
 * port. Every refusal is a typed `BlockedError` naming what was refused and
 * why, because an agent that gets a vague failure will try something else, and
 * an owner reading the audit log deserves the actual reason.
 */
import { isIP } from 'node:net';
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';

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

/* ------------------------------------------------------------------ *
 * The resolver the socket itself uses
 * ------------------------------------------------------------------ */

/** The slice of `node:dns` this needs, so a test can answer without a network. */
export type LookupAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const realLookup: LookupAll = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * A `lookup` for the socket that refuses to resolve anything private.
 *
 * Handed to the transport, which hands it to `net.connect`, which uses its
 * answer *as* the address. That is the whole point: there is no second
 * resolution for an attacker's second answer to win.
 *
 * **Every** address the name returns must be public. Not "the first one", not
 * "one of them": a name that answers `[1.2.3.4, 127.0.0.1]` is a name trying
 * something, and which of the two a given Node version picks is not a security
 * property anybody should be relying on.
 */
export function guardedLookup(
  resolve: LookupAll = realLookup,
  policy: AddressPolicy = DEFAULT_POLICY,
): LookupFunction {
  return function lookup(hostname, options, callback): void {
    // Node calls this with (hostname, options, cb); the options object says
    // whether the caller wants one address or all of them.
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      all?: boolean;
      family?: number;
    };
    const done = callback as (
      err: NodeJS.ErrnoException | null,
      address?: any,
      family?: number,
    ) => void;

    if (policy.blockedHostname(hostname)) {
      done(new BlockedError('hostname', `refusing to resolve "${hostname}" — it names this machine or its local network`));
      return;
    }

    resolve(hostname).then(
      (answers) => {
        if (answers.length === 0) {
          done(new BlockedError('unresolvable', `"${hostname}" resolves to no address`));
          return;
        }
        for (const answer of answers) {
          const why = policy.blocked(answer.address);
          if (why !== null) {
            done(
              new BlockedError(
                'private-address',
                `refusing "${hostname}": it resolves to ${answer.address}, which is ${why}. ` +
                  'A public-looking name pointing inside this machine or its network is exactly what this check is for.',
              ),
            );
            return;
          }
        }
        const wanted =
          opts.family === 4 || opts.family === 6
            ? answers.filter((a) => a.family === opts.family)
            : answers;
        const usable = wanted.length > 0 ? wanted : answers;
        if (opts.all === true) {
          done(null, usable.map((a) => ({ address: a.address, family: a.family })));
          return;
        }
        const first = usable[0] as { address: string; family: number };
        done(null, first.address, first.family);
      },
      (err: unknown) => {
        done(
          new BlockedError(
            'unresolvable',
            `could not resolve "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    );
  } as LookupFunction;
}
