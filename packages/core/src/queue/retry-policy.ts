/**
 * How long a job is allowed to keep trying, and whether it should try at all.
 *
 * Two decisions live here, and they were previously either missing or wrong.
 *
 * **1. The horizon depends on who is waiting.**
 *
 * The provider adapter retries over about four seconds (`RETRY_DELAYS_MS` in
 * the runtime) and the queue used to retry at one minute and five minutes and
 * then die — six minutes of total life. For a turn the owner is waiting on,
 * that is right: fail fast and say so. For a triage run with no deadline it is
 * indefensible. A network blip on one evening killed twelve mail triage runs in
 * about six minutes each and the mail was never read.
 *
 * So the queue carries two profiles. `interactive` keeps the old six-minute
 * shape for anything someone is waiting on. `unattended` — work started by a
 * clock or by the world changing, on the owner's behalf, with nobody at the
 * keyboard — keeps trying for hours on an escalating curve. The long wait lives
 * *here*, in the durable queue, and never inside a process holding a lease: a
 * worker that slept for an hour mid-run would be an outage of its own.
 *
 * **2. Not every failure deserves a horizon at all.**
 *
 * A transport error, a 429 or a 5xx is a statement about right now, and time is
 * the fix. A 400, an auth failure or a rejected tool schema is a statement
 * about the request, and it will be exactly as wrong in six hours. A schema bug
 * shipped in the morning must not spend the afternoon retrying. So every
 * failure is classified before it is retried, and a permanent one dies on the
 * first attempt with the reason recorded.
 *
 * The classification is structural, never `instanceof`: core does not import
 * the runtime, so it reads the shape a typed provider error happens to have
 * (`status`, `type`), Node's `code`, and the message as a last resort.
 *
 * The `code` is read from the **whole cause chain**, not from the error the
 * caller caught. `fetch failed` is a `TypeError` with no `code` at all; the
 * `ECONNRESET` that actually happened is one link down, on `err.cause`. Reading
 * only the top link meant a socket failure was recognised — if at all — by a
 * regular expression over the word "fetch", which is exactly as precise as it
 * sounds.
 *
 * A failure that matches neither list is `unknown`, and that is a third answer
 * rather than a lean towards either. It is retried — a handler that throws has
 * always been retried and usually deserves to be — but only on the short
 * interactive horizon, never on the six-hour one. The long wait is a privilege
 * granted to failures we recognise as "not now"; an unrecognised one is more
 * often a bug in our own code, and spending an afternoon on it helps nobody.
 */

import { errorCodes } from '../failures/cause.js';

export type FailureClass = 'transient' | 'permanent' | 'unknown';

export interface FailureVerdict {
  class: FailureClass;
  /** Why, in words a person can read. Recorded on the job's failure event. */
  reason: string;
}

/** HTTP statuses that mean "not now" rather than "not ever". */
export function isTransientStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status === 529) return true; // Anthropic: overloaded
  return status >= 500 && status <= 599;
}

/** Provider error `type` values that can never be fixed by waiting. */
const PERMANENT_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'unsupported_content',
  'billing_error',
]);

/** Provider error `type` values that are worth waiting out. */
const TRANSIENT_TYPES = new Set([
  'transport_error',
  'overloaded_error',
  'rate_limit_error',
  'api_error',
  'timeout_error',
]);

/** Node/undici socket and DNS failures, plus libpq's connection classes. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RESPONSE_TIMEOUT',
  'UND_ERR_SOCKET',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  // A pooled HTTP/2 session the far end had already closed. It is the fault
  // that killed a day of turns, and it is "not now" from the request's point of
  // view — the remedy is in `runtime/transport.ts`, which no longer pools one.
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_STREAM_CANCEL',
  // Postgres: admin shutdown, crash shutdown, cannot connect now, too many
  // connections, and the 08xxx connection-exception class.
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08P01',
]);

/** Last resort: the message. Only unambiguous network phrasings count. */
const TRANSIENT_MESSAGES: readonly RegExp[] = [
  /\bfetch failed\b/i,
  /\bsocket hang up\b/i,
  /\bnetwork (?:error|is unreachable|is down)\b/i,
  /\b(?:connection|connect) (?:reset|refused|timed out|closed|terminated)\b/i,
  /\bterminating connection\b/i,
  /\brequest (?:timed out|timeout)\b/i,
  /\btimed out after \d+ms\b/i,
];

/**
 * A credential this machine cannot use. `resolveProvider` writes exactly these
 * sentences, and the gateway wraps them with the problem code in brackets.
 */
const CREDENTIAL_MESSAGES: readonly RegExp[] = [
  /\[(?:missing|empty)-credential\]/i,
  /environment variable [A-Z][A-Z0-9_]* is (?:not set|empty)/,
];

/** Errors from our own code. Retrying a `TypeError` is retrying a bug. */
const PROGRAMMING_ERRORS = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

/**
 * Is this failure worth waiting out, or is it settled?
 *
 * Read in order: the error's own `type`, then its HTTP status, then a
 * Node/Postgres `code`, then the error class, then the message. The first
 * signal that answers wins, so a typed provider error is never second-guessed
 * by a string match.
 */
export function classifyFailure(err: unknown): FailureVerdict {
  const type = readString(err, 'type');
  if (type && PERMANENT_TYPES.has(type)) {
    return { class: 'permanent', reason: `the request itself was refused (${type})` };
  }
  if (type && TRANSIENT_TYPES.has(type)) {
    return { class: 'transient', reason: `the provider could not answer right now (${type})` };
  }

  const status = readNumber(err, 'status') ?? readNumber(err, 'statusCode');
  if (status !== undefined && status > 0) {
    if (isTransientStatus(status)) {
      return { class: 'transient', reason: `the provider answered ${status}` };
    }
    if (status >= 400 && status < 500) {
      return { class: 'permanent', reason: `the provider answered ${status} and will again` };
    }
  }

  // The whole chain, outermost first: `fetch failed` carries no code of its
  // own and the socket error that caused it carries the only one that matters.
  for (const code of errorCodes(err)) {
    if (TRANSIENT_CODES.has(code)) {
      return { class: 'transient', reason: `the connection failed (${code})` };
    }
  }

  // A credential that is absent, empty or refused is settled until a person
  // changes a file. Retrying it for six hours helps nobody and hides it.
  if (CREDENTIAL_MESSAGES.some((re) => re.test(messageOf(err)))) {
    return { class: 'permanent', reason: 'the credential it needs is not usable' };
  }

  // Before the error *class*, because `fetch failed` is a `TypeError` and it is
  // not a defect in our code. A network phrasing outranks the constructor that
  // happened to carry it.
  const message = messageOf(err);
  if (message !== '' && TRANSIENT_MESSAGES.some((re) => re.test(message))) {
    return { class: 'transient', reason: 'the connection failed' };
  }

  const name = readString(err, 'name');
  if (name && PROGRAMMING_ERRORS.has(name)) {
    return { class: 'permanent', reason: `${name} — this is a defect, not a blip` };
  }
  if (name === 'ZodError') {
    return { class: 'permanent', reason: 'the data did not match its schema' };
  }

  return { class: 'unknown', reason: 'the failure was not recognised' };
}

/** A retry curve, and the two bounds that stop it being infinite. */
export interface RetryProfile {
  name: 'interactive' | 'unattended';
  /** Hard cap on attempts, including the first. */
  maxAttempts: number;
  /** Wait before attempt n+1, indexed by attempts already spent. */
  delaysMs: readonly number[];
  /** Hard cap on the job's total life, measured from when it was enqueued. */
  maxLifetimeMs: number;
}

/**
 * Somebody is waiting. Three attempts over six minutes, exactly as before —
 * this is the shape the queue has always had, kept deliberately.
 */
export const INTERACTIVE_RETRY_PROFILE: RetryProfile = {
  name: 'interactive',
  maxAttempts: 3,
  delaysMs: [60_000, 300_000],
  maxLifetimeMs: 15 * 60_000,
};

/**
 * Nobody is waiting, and the work still has to happen.
 *
 * Eight attempts on 1m, 5m, 15m, 30m, 1h, 1h, 1h — about four hours of trying —
 * inside a six-hour lifetime. Both bounds are real: whichever is reached first
 * ends the job, so a job can never retry forever, and an outage that outlasts a
 * working day is reported rather than chased.
 */
export const UNATTENDED_RETRY_PROFILE: RetryProfile = {
  name: 'unattended',
  maxAttempts: 8,
  delaysMs: [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000],
  maxLifetimeMs: 6 * 60 * 60_000,
};

/**
 * The job kinds that are work the owner is relying on, with nobody watching.
 *
 * Named here as strings rather than imported, because core must not depend on
 * the gateway that defines them (ARCHITECTURE.md principle 6). The gateway owns
 * the constants; a test there asserts the two lists agree, which is what keeps
 * this honest.
 */
export const UNATTENDED_JOB_KINDS: readonly string[] = ['agent-run', 'mission-run'];

export function isUnattendedKind(kind: string): boolean {
  return UNATTENDED_JOB_KINDS.includes(kind);
}

export function retryProfileFor(kind: string): RetryProfile {
  return isUnattendedKind(kind) ? UNATTENDED_RETRY_PROFILE : INTERACTIVE_RETRY_PROFILE;
}

/**
 * Wait before the next attempt, given how many are already spent. Past the end
 * of the curve the last delay repeats — the curve escalates, it never resets.
 */
export function retryDelayMs(profile: RetryProfile, attemptsSpent: number): number {
  const delays = profile.delaysMs;
  if (delays.length === 0) return 0;
  const index = Math.min(Math.max(attemptsSpent - 1, 0), delays.length - 1);
  return delays[index] as number;
}

export interface RetryDecisionInput {
  kind: string;
  /** Attempts already spent — the queue increments this on claim. */
  attempts: number;
  /** The row's own cap; an old row keeps the cap it was enqueued with. */
  maxAttempts: number;
  createdAt: Date;
  now: Date;
  error: unknown;
}

export interface RetryDecision {
  retry: boolean;
  /** Only when `retry`. */
  backoffMs?: number;
  failureClass: FailureClass;
  /** One line, for the failure event and the owner-facing message. */
  reason: string;
}

/**
 * Should this failed attempt be tried again, and when?
 *
 * Four ways to stop, in order: the failure is permanent, the attempts are
 * spent, the lifetime is spent, or the next wait would run past the lifetime.
 * The last one matters — without it a job scheduled at 5h55m into a six-hour
 * window wakes up only to be killed, and the owner hears about it an hour late.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const verdict = classifyFailure(input.error);
  if (verdict.class === 'permanent') {
    return { retry: false, failureClass: 'permanent', reason: verdict.reason };
  }

  // Only a recognised "not now" earns the kind's own horizon. An unrecognised
  // failure is retried on the interactive curve whatever the kind is.
  const profile =
    verdict.class === 'transient' ? retryProfileFor(input.kind) : INTERACTIVE_RETRY_PROFILE;
  const maxAttempts = Math.min(input.maxAttempts, profile.maxAttempts);

  if (input.attempts >= maxAttempts) {
    return {
      retry: false,
      failureClass: verdict.class,
      reason: `gave up after ${input.attempts} attempts — ${verdict.reason}`,
    };
  }

  const age = input.now.getTime() - input.createdAt.getTime();
  const backoffMs = retryDelayMs(profile, input.attempts);
  if (age >= profile.maxLifetimeMs || age + backoffMs >= profile.maxLifetimeMs) {
    return {
      retry: false,
      failureClass: verdict.class,
      reason: `gave up after ${Math.round(profile.maxLifetimeMs / 60_000)} minutes of retrying — ${verdict.reason}`,
    };
  }

  return { retry: true, backoffMs, failureClass: verdict.class, reason: verdict.reason };
}
