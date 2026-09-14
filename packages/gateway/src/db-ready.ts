/**
 * Is the database there?
 *
 * Everything in this installation is downstream of one TCP connection, so the
 * failure that matters most on a fresh boot is the dullest one: Docker Desktop
 * did not start, the container is gone, and every entry point dies on a
 * connection refused. `pg` reports that as an `AggregateError` whose own
 * message is empty — which is how `buddi serve` came to print the single word
 * `AggregateError:` and exit.
 *
 * This module is the answer to that, and it is deliberately tiny and pure at
 * the edges: `describeDatabaseError` turns any throw into one sentence the
 * owner can act on, `probeDatabase` asks the question, and `waitForDatabase`
 * is the loop the *service* runs instead of exiting — so launchd's KeepAlive
 * has nothing to crash-loop on and the installation heals itself the moment
 * Docker comes back.
 *
 * The CLI does the opposite with the same sentence: it fails fast. A person is
 * waiting at a prompt; a retry loop there would just hang.
 */
import { createPool } from '@buddi/core';

/** Errno codes that mean "nothing is listening / cannot get there". */
export const CONNECTION_ERROR_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
];

/** `localhost:55433` from a connection string; the raw string if it will not parse. */
export function hostPortOf(databaseUrl: string | undefined): string {
  if (!databaseUrl || databaseUrl.trim() === '') return 'the configured database';
  try {
    const u = new URL(databaseUrl);
    const host = u.hostname || 'localhost';
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return databaseUrl;
  }
}

/** Every error inside an `AggregateError` tree, plus every `cause` along the way. */
function* flatten(err: unknown, depth = 0): Generator<unknown> {
  if (depth > 8 || err === null || err === undefined) return;
  yield err;
  if (err instanceof AggregateError) {
    for (const inner of err.errors) yield* flatten(inner, depth + 1);
  }
  const cause: unknown = (err as { cause?: unknown }).cause;
  if (cause !== undefined) yield* flatten(cause, depth + 1);
}

/**
 * True when the throw is "the database is not accepting connections".
 *
 * `pg` wraps the per-address attempts of a dual-stack host in an
 * `AggregateError`, so the code is never on the outer error — it has to be
 * looked for.
 */
export function isConnectionError(err: unknown): boolean {
  for (const e of flatten(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.includes(code)) return true;
    const message = e instanceof Error ? e.message : '';
    if (CONNECTION_ERROR_CODES.some((c) => message.includes(c))) return true;
  }
  return false;
}

/** The one line a failed connection is worth. */
export function databaseUnreachableMessage(databaseUrl: string | undefined): string {
  return `database not reachable at ${hostPortOf(
    databaseUrl,
  )} — is Docker running? try: buddi db up`;
}

/**
 * Any throw, as a sentence.
 *
 * A connection failure becomes the actionable line; anything else keeps its own
 * message, unwrapped out of the `AggregateError` that may be hiding it. The one
 * thing this never returns is an empty string, which is what produced the bare
 * `AggregateError:` in the first place.
 */
export function describeDatabaseError(err: unknown, databaseUrl?: string): string {
  if (isConnectionError(err)) return databaseUnreachableMessage(databaseUrl);
  for (const e of flatten(err)) {
    const message = e instanceof Error ? e.message.trim() : typeof e === 'string' ? e.trim() : '';
    if (message !== '') return message;
  }
  return databaseUnreachableMessage(databaseUrl);
}

/** A failed probe, already carrying the sentence. */
export class DatabaseUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DatabaseUnreachableError';
  }
}

/** How long a readiness probe waits before calling it unreachable. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Open one connection, ask `select 1`, close it.
 *
 * Its own pool, not the installation's: this runs *before* the wiring exists,
 * and a probe must never leave a half-connected pool behind.
 */
export async function probeDatabase(
  databaseUrl: string | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<void> {
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new DatabaseUnreachableError('DATABASE_URL is not set — run `buddi init`');
  }
  const pool = createPool(databaseUrl);
  // A probe that hangs is a probe that failed; `pg`'s own connect timeout is
  // off by default, so the deadline is imposed here.
  const timer = setTimeout(() => {
    void pool.end().catch(() => {});
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    await pool.query('select 1');
  } catch (err) {
    throw new DatabaseUnreachableError(describeDatabaseError(err, databaseUrl), err);
  } finally {
    clearTimeout(timer);
    await pool.end().catch(() => {});
  }
}

/**
 * The CLI's version: probe, or print one line and exit 1.
 *
 * Returns the exit code rather than calling `process.exit`, so the dispatcher
 * stays the only thing in the binary that ends the process.
 */
export async function requireDatabase(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  try {
    await probeDatabase(databaseUrl);
    return 0;
  } catch (err) {
    log(describeDatabaseError(err, databaseUrl));
    return 1;
  }
}

/** 5s, 10s, 20s, 40s, then a minute forever. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000];
export const MAX_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_DELAYS_MS[attempt - 1] ?? MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
}

/** How often the wait loop is allowed to say the same thing. */
export const LOG_EVERY_MS = 60_000;

export interface WaitForDatabaseOptions {
  databaseUrl?: string | undefined;
  /** Injected in tests; defaults to the real probe. */
  probe?: (url: string | undefined) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Stop after this many failures instead of never. Tests only. */
  maxAttempts?: number;
}

/**
 * Wait, forever, for the database.
 *
 * This is what `buddi serve` does instead of exiting, and the reason is
 * launchd: a process that exits 1 under `KeepAlive` is restarted immediately,
 * which turns a stopped Docker into a crash loop and a job that launchd
 * eventually throttles into "loaded but not running". Staying up and retrying
 * is both quieter and self-healing — the first tick after Docker starts
 * connects and the service carries on.
 *
 * It says the same sentence at most once a minute, so a laptop left closed
 * overnight does not produce a hundred megabytes of log.
 */
export async function waitForDatabase(opts: WaitForDatabaseOptions = {}): Promise<number> {
  const {
    databaseUrl = process.env.DATABASE_URL,
    probe = (url: string | undefined) => probeDatabase(url),
    sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    now = () => Date.now(),
    log = (line: string) => console.error(line),
    maxAttempts,
  } = opts;

  let attempt = 0;
  let lastLoggedAt: number | undefined;
  for (;;) {
    try {
      await probe(databaseUrl);
      if (attempt > 0) log(`database reachable again after ${attempt} attempt(s) — starting`);
      return attempt;
    } catch (err) {
      attempt += 1;
      const delay = retryDelayMs(attempt);
      const at = now();
      if (lastLoggedAt === undefined || at - lastLoggedAt >= LOG_EVERY_MS) {
        lastLoggedAt = at;
        log(
          `${describeDatabaseError(err, databaseUrl)} — attempt ${attempt}, retrying in ${
            delay / 1000
          }s (this service keeps waiting; it will start on its own)`,
        );
      }
      if (maxAttempts !== undefined && attempt >= maxAttempts) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      await sleep(delay);
    }
  }
}
