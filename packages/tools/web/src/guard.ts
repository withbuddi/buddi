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
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { BlockedError, DEFAULT_POLICY, type AddressPolicy } from '@buddi/core/plugin';

/*
 * Everything decidable from the URL alone — the schemes, the ports, the
 * address blocks and `checkUrl` — lives in `@buddi/core/plugin` now, so a
 * plugin can check a URL without importing this one
 * (docs/specs/plugin-host-api.md §3). Re-exported unchanged: every importer of
 * this file, and of `@buddi/tool-web`, keeps working.
 */
export {
  ALLOWED_PORTS,
  ALLOWED_SCHEMES,
  BlockedError,
  DEFAULT_POLICY,
  blockedAddress,
  blockedV4,
  blockedV6,
  checkUrl,
  isBlockedHostname,
  type AddressPolicy,
  type BlockReason,
  type CheckedUrl,
} from '@buddi/core/plugin';

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
