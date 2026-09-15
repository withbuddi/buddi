/**
 * The cause chain: what actually went wrong, under the word the caller saw.
 *
 * This file exists because of a day that taught us nothing. A turn died, the
 * owner was shown `Something went wrong: fetch failed`, the log recorded
 * `telegram: run failed: fetch failed`, and 129 more lines just like it piled
 * up over the next hours. `fetch failed` is undici's generic wrapper: the real
 * error — a socket that was already closed, a DNS errno, a TLS alert — is
 * hanging off `err.cause`, and nothing anywhere read it. A whole day of
 * failures produced one string, and that string named the wrapper rather than
 * the fault.
 *
 * So every failure is flattened here before it is written anywhere. The chain
 * is walked to the bottom (`cause`, and an `AggregateError`'s `errors`), and
 * each link contributes the three things that identify a fault: what class of
 * error it was, what it said, and the machine-readable `code`/`errno`/`syscall`
 * that a person can actually search for.
 *
 * Two rules keep this safe to call on anything:
 *
 *  - **It never throws.** It is called from `catch` blocks, on values that are
 *    not necessarily errors, sometimes while something else is already on fire.
 *  - **It terminates.** Depth is capped and every link is remembered, so an
 *    error whose `cause` is itself — or two errors that cause each other — ends
 *    the walk instead of hanging the process.
 *
 * It is for the *log*. What the owner reads is built from the classification,
 * not from this: see `owner-message.ts`.
 */

/** One link of the chain, flattened to the fields worth recording. */
export interface CauseLink {
  /** The error's class: `TypeError`, `SocketError`, `ProviderError`. */
  name: string;
  message: string;
  /** Node/undici/libpq's own identifier: `ECONNRESET`, `UND_ERR_SOCKET`, `57P01`. */
  code?: string;
  errno?: number;
  syscall?: string;
  /** Where it was going, when the error knows. Never a credential. */
  address?: string;
  port?: number;
}

/** How deep the walk goes before it gives up and says so. */
export const MAX_CAUSE_DEPTH = 8;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function linkOf(err: unknown): CauseLink {
  if (typeof err !== 'object' || err === null) {
    return { name: typeof err, message: String(err) };
  }
  const e = err as Record<string, unknown>;
  const link: CauseLink = {
    name: str(e.name) ?? (err instanceof Error ? 'Error' : 'object'),
    message: str(e.message) ?? '',
  };
  const code = str(e.code);
  if (code !== undefined) link.code = code;
  const errno = num(e.errno);
  if (errno !== undefined) link.errno = errno;
  const syscall = str(e.syscall);
  if (syscall !== undefined) link.syscall = syscall;
  const address = str(e.address);
  if (address !== undefined) link.address = address;
  const port = num(e.port);
  if (port !== undefined) link.port = port;
  return link;
}

/**
 * Every link from the error the caller caught down to the one that started it.
 *
 * An `AggregateError`'s members are appended after their parent rather than
 * followed separately: `fetch` to a host with both an A and an AAAA record
 * fails as an aggregate of two connection errors, and either one may be the
 * interesting one.
 */
export function causeChain(err: unknown, maxDepth: number = MAX_CAUSE_DEPTH): CauseLink[] {
  const out: CauseLink[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];

  while (queue.length > 0 && out.length < maxDepth) {
    const current = queue.shift();
    if (current === undefined || current === null) continue;
    if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
    }
    out.push(linkOf(current));

    if (typeof current !== 'object') continue;
    const e = current as Record<string, unknown>;
    if (Array.isArray(e.errors)) queue.push(...e.errors);
    if (e.cause !== undefined) queue.push(e.cause);
  }
  return out;
}

/** One link as a line: `SocketError: other side closed [UND_ERR_SOCKET]`. */
export function describeLink(link: CauseLink): string {
  const tags: string[] = [];
  if (link.code !== undefined) tags.push(link.code);
  if (link.errno !== undefined) tags.push(`errno ${link.errno}`);
  if (link.syscall !== undefined) tags.push(link.syscall);
  if (link.address !== undefined) {
    tags.push(link.port === undefined ? link.address : `${link.address}:${link.port}`);
  }
  const head = link.message === '' ? link.name : `${link.name}: ${link.message}`;
  return tags.length === 0 ? head : `${head} [${tags.join(' ')}]`;
}

/**
 * The whole chain on one line, for a log: the wrapper first, the fault last.
 *
 *   TypeError: fetch failed <- SocketError: other side closed [UND_ERR_SOCKET]
 *
 * This is the line that should have existed on the first failure.
 */
export function describeCause(err: unknown, maxDepth: number = MAX_CAUSE_DEPTH): string {
  const chain = causeChain(err, maxDepth);
  if (chain.length === 0) return String(err);
  return chain.map(describeLink).join(' <- ');
}

/** Every `code` in the chain, outermost first. Empty when none carries one. */
export function errorCodes(err: unknown, maxDepth: number = MAX_CAUSE_DEPTH): string[] {
  const out: string[] = [];
  for (const link of causeChain(err, maxDepth)) {
    if (link.code !== undefined && !out.includes(link.code)) out.push(link.code);
  }
  return out;
}

/** The innermost error's message — the one that actually says what happened. */
export function rootMessage(err: unknown, maxDepth: number = MAX_CAUSE_DEPTH): string {
  const chain = causeChain(err, maxDepth);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const message = chain[i]?.message;
    if (message !== undefined && message !== '') return message;
  }
  return chain[0]?.name ?? String(err);
}
