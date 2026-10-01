/**
 * What a person is told when a turn fails.
 *
 * The owner asked @postman to draft a reply, waited, and read this:
 *
 *     Something went wrong: fetch failed
 *
 * Two words of undici's vocabulary, pasted into a chat window. It tells him
 * nothing about what happened, nothing about whether it was his fault, and
 * nothing about what to do next — and it looks like a crash, which it was not.
 * Every surface did the same thing, because every surface had the same line:
 * `Something went wrong: ${err.message}`.
 *
 * The rule this file exists to enforce is simple and absolute: **the raw error
 * goes to the log, in full, with its whole cause chain; what reaches the owner
 * is a sentence written for a person.** No tool names, no stack, no `undici`,
 * no `ECONNRESET`.
 *
 * ## It says something different for each kind of failure
 *
 * The classification is not a second one. `classifyFailure` in
 * `queue/retry-policy.ts` already decides transient / permanent / unknown for
 * the durable queue, and this reads the same verdict — one classifier, so the
 * sentence the owner reads and the decision to retry can never disagree.
 *
 *  - **transient** — the provider or the network was unreachable *just now*.
 *    Time is the fix, so the sentence says so and the surface offers a retry.
 *  - **permanent** — the request itself was refused and will be refused again.
 *    Saying "try again" here would be a lie, so no retry is offered. A missing
 *    or expired credential is called out by name, because on a self-hosted
 *    install the person reading this is also the person who can fix it.
 *  - **unknown** — we genuinely do not know. That deserves an apology and a
 *    way forward, not a guess dressed up as a diagnosis.
 *
 * ## The sentences are surface-neutral
 *
 * Plain text, no markdown, no backticks: the same string has to be legible in
 * Telegram (where a backtick is a backtick), in a terminal, and on a page.
 */
import { classifyFailure, type FailureClass } from '../queue/retry-policy.js';
import { timezoneFromEnv } from '../time.js';
import { describeCause } from './cause.js';

/** What the owner reads, what the log gets, and whether a retry is honest. */
export interface OwnerFailure {
  class: FailureClass;
  /** The sentences the owner reads. Never contains the raw error. */
  text: string;
  /**
   * May this surface offer to run it again?
   *
   * False for a permanent failure, where the second attempt fails identically
   * and the button is a lie. True for transient and for unknown — an
   * unrecognised failure is not a known-hopeless one, and "try again" is the
   * only honest way forward we have for it.
   */
  retryable: boolean;
  /** The whole error, cause chain included. For the log, never for the chat. */
  detail: string;
}

export interface DescribeFailureOptions {
  /** How the agent is named out loud, e.g. `@postman`. Used where it helps. */
  agentName?: string | undefined;
  /**
   * Did the failed attempt already call a tool?
   *
   * It changes what is honest to say and what is safe to offer: work that
   * already happened cannot be un-happened by a retry. See
   * `retryWithheldText`.
   */
  toolsCalled?: number | undefined;
  /** The zone a reset time is said in. The installation's (`BUDDI_TZ`) by default. */
  timeZone?: string | undefined;
  /** The clock a reset time is measured against. */
  now?: Date | undefined;
}

/** The label on the button, and the words for a surface that has no buttons. */
export const RETRY_OFFER_LABEL = 'Try again';

/**
 * Said instead of offering the button when the failed attempt got as far as
 * doing something.
 *
 * The honest position: by the time the provider call failed, the tool calls
 * that had already run were done, and their results are in the transcript. We
 * cannot know whether repeating them is harmless — `reminder.create` twice is
 * two reminders — so we do not quietly repeat them behind a button. Anything
 * that leaves the machine was gated and stopped the run before it executed, so
 * this is never about a sent mail; it is about not doing local work twice
 * without being asked.
 */
export function retryWithheldText(toolsCalled: number): string {
  const steps = toolsCalled === 1 ? 'one step' : `${toolsCalled} steps`;
  return (
    `I had already got through ${steps} before this happened, so I have not offered to ` +
    'just redo it — that could repeat work that already went through. Tell me how you want ' +
    'to carry on and I will pick it up from there.'
  );
}

const TRANSIENT_TEXT =
  "I couldn't reach the model just now — the connection didn't get through. " +
  'That is almost always a passing blip, and trying again usually works.';

const UNKNOWN_TEXT =
  "Sorry — that went wrong on my side, and I can't tell you anything useful about why. " +
  'The details are in the log. Trying again is worth a go.';

/** The cure for a credential variable that is not set. */
function howToSet(envVar: string): string {
  return `Set ${envVar} in your .env and restart buddi.`;
}

/**
 * The environment variable a credential failure is about, when the error names
 * one.
 *
 * Structural where it can be (`provider.credential.env` on a resolution
 * problem) and a narrow pattern otherwise, matching the one sentence
 * `resolveProvider` writes: "environment variable X is not set".
 */
export function credentialEnvVar(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const named = (err as Record<string, unknown>).credentialEnv;
    if (typeof named === 'string' && named.trim() !== '') return named.trim();
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = /environment variable ([A-Z][A-Z0-9_]*) is (?:not set|empty)/.exec(message);
  return match?.[1];
}

/**
 * A refusal about the account's usage or billing, in the provider's own words.
 *
 * Anthropic answered a subscription sign-in on 2026-09-29 with "Third-party
 * apps now draw from your extra usage, not your plan limits. Add more at
 * claude.ai/settings/usage and keep going." — a sentence written for a
 * person, about the account rather than the request. Filed under the
 * credential sentence it read as "replace the key in your .env", which was
 * wrong twice over. When a 4xx carries a sentence like that, the owner reads
 * it: it is the provider's prose, not a stack, and it names the cure.
 */
function usageRefusal(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === undefined || status < 400 || status >= 500) return undefined;
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  if (!/\b(extra usage|plan limits?|usage limits?|credits?|billing|quota|spending limit|balance)\b/i.test(message)) return undefined;
  // Prose only: a sentence with spaces and no JSON, no braces, no code.
  if (message.length < 20 || message.length > 400 || /[{}<>`]/.test(message)) return undefined;
  return message;
}

/** Auth failures that are about a credential rather than about the request. */
function isCredentialFailure(err: unknown): boolean {
  if (credentialEnvVar(err) !== undefined) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  const type = typeof e.type === 'string' ? e.type : '';
  if (type === 'authentication_error' || type === 'permission_error') return true;
  const status = typeof e.status === 'number' ? e.status : undefined;
  return status === 401 || status === 403;
}

/** A plain-words reason for a permanent failure that is not about a credential. */
function permanentReason(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    if (e.name === 'ZodError') return 'the data came back in a shape it should never have been in';
    if (typeof e.name === 'string' && /^(Type|Reference|Syntax|Range)Error$/.test(e.name)) {
      return 'something in buddi itself is broken — this is a defect, not a hiccup';
    }
    const status = typeof e.status === 'number' ? e.status : undefined;
    if (status === 404) return 'what it asked for does not exist';
    if (status === 413) return 'the request was too big to send';
    if (status !== undefined && status >= 400 && status < 500) {
      return 'the provider rejected the request as invalid';
    }
  }
  return 'the request was refused';
}

/** What a provider's limit said, read structurally (core does not import the runtime). */
export interface FailureRateLimit {
  scope: 'day' | 'burst';
  retryAt: string | null;
  limit?: number;
  unit?: 'requests' | 'tokens';
  freeTier?: boolean;
  provider?: string;
}

/** The limit a failure carries, or undefined when it is not a rate limit. */
export function rateLimitOf(err: unknown): FailureRateLimit | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  // Out of credit is not a pace: OpenAI says it with a 429 too.
  if (e.type === 'insufficient_quota') return undefined;
  const raw = e.limit;
  if (raw && typeof raw === 'object') {
    const l = raw as Record<string, unknown>;
    const scope = l.scope === 'day' ? 'day' : 'burst';
    const retryAt = typeof l.retryAt === 'string' && Number.isFinite(Date.parse(l.retryAt)) ? l.retryAt : null;
    return {
      scope, retryAt,
      ...(typeof l.limit === 'number' && Number.isFinite(l.limit) ? { limit: l.limit } : {}),
      ...(l.unit === 'requests' || l.unit === 'tokens' ? { unit: l.unit } : {}),
      ...(l.freeTier === true ? { freeTier: true } : {}),
      ...(typeof l.provider === 'string' && l.provider.length <= 60 ? { provider: l.provider } : {}),
    };
  }
  // A 429 that said nothing about itself is still a limit, not a lost connection.
  if (e.status === 429 && usageRefusal(err) === undefined) {
    const retryAt = typeof e.retryAt === 'string' && Number.isFinite(Date.parse(e.retryAt)) ? e.retryAt : null;
    return { scope: 'burst', retryAt };
  }
  return undefined;
}

/**
 * When a reset happens, in the owner's words: "14:20" today, "tomorrow at
 * 09:00", "on Fri 2 Oct at 09:00" further out.
 */
export function resetPhrase(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  let zone = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'UTC'; }
  const day = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  if (day(at) === day(now)) return time;
  if (day(at) === day(new Date(now.getTime() + 86_400_000))) return `tomorrow at ${time}`;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(at);
  return `on ${date} at ${time}`;
}

/**
 * The sentence for a provider's rate limit, or undefined when the failure is
 * not one. A spent daily quota is not offered a retry: the same call fails
 * the same way until the reset. A short burst is — after its window.
 */
function rateLimitText(err: unknown, options: DescribeFailureOptions): Omit<OwnerFailure, 'detail'> | undefined {
  const limit = rateLimitOf(err);
  if (limit === undefined) return undefined;
  const who = limit.provider ?? 'The provider';
  const zone = options.timeZone ?? timezoneFromEnv();
  const now = options.now ?? new Date();
  const when = limit.retryAt ? resetPhrase(limit.retryAt, zone, now) : undefined;
  if (limit.scope === 'day') {
    const what = limit.unit === 'tokens' ? 'tokens' : 'requests';
    const allowance = limit.limit !== undefined
      ? `${limit.freeTier ? `${who}'s free tier allows` : `${who} allows this account`} ${limit.limit.toLocaleString('en-US')} ${what} a day`
      : `${who} says this account has used up today's allowance`;
    const reset = when ? `; it resets ${/^(tomorrow|on )/.test(when) ? when : `at ${when}`}.` : '.';
    const billing = limit.freeTier && limit.provider === 'Gemini' ? ', or turn on billing for the key at aistudio.google.com' : '';
    return {
      class: 'transient', retryable: false,
      text: `${allowance}${reset} Until then, give this agent another account in Settings → Model accounts${billing}.`,
    };
  }
  const pace = `${who} is limiting how fast this account can send requests`;
  return {
    class: 'transient', retryable: true,
    text: when
      ? `${pace}, and asked to wait until ${when.replace(/^on /, '')} — longer than I hold a conversation for. Try again after that.`
      : `${pace} right now. Wait a minute, then try again.`,
  };
}

/**
 * Turn any thrown thing into what the owner reads and what the log records.
 *
 * Total: it is called from `catch` blocks and must not add a second failure to
 * the first, so nothing here can throw.
 */
export function describeFailure(
  err: unknown,
  options: DescribeFailureOptions = {},
): OwnerFailure {
  const detail = describeCause(err);

  // The room outgrew what its members can be sent, and could not be made to
  // fit. Sending the same message again would fail the same way: the fix is
  // a new thread, or a bigger cap for the group.
  if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ProjectionOverflow') {
    const { chars, cap } = err as { chars?: number; cap?: number };
    const sizes = typeof chars === 'number' && typeof cap === 'number' ? ` It is ${chars.toLocaleString()} characters against a cap of ${cap.toLocaleString()}.` : '';
    return {
      class: 'permanent', retryable: false, detail,
      text: `This conversation has grown past what the group's agents can be sent, and one piece of it is too large to shorten.${sizes} Sending the same message again will not help: start a new conversation for the group, or raise its context cap.`,
    };
  }

  const limited = rateLimitText(err, options);
  if (limited !== undefined) return { ...limited, detail };

  const verdict = classifyFailure(err);

  if (verdict.class === 'transient') {
    return { class: 'transient', text: TRANSIENT_TEXT, retryable: true, detail };
  }

  if (verdict.class === 'permanent') {
    if (typeof err === 'object' && err !== null && (err as Record<string, unknown>).type === 'model_not_supported') {
      return { class: 'permanent', retryable: false, detail,
        text: 'The selected model is not available for this provider account. Open agent settings and choose a model supported by the assigned account, then send your message again.' };
    }
    const usage = usageRefusal(err);
    if (usage !== undefined) {
      const who = options.agentName ? `${options.agentName} can't` : "I can't";
      return {
        class: 'permanent', retryable: false, detail,
        text:
          `${who} use the model right now: its provider refused the call because of the account, not the request. ` +
          `It said: "${usage.replace(/"/g, "'")}" ` +
          'Trying again changes nothing until the account does: add usage there, or give this agent another account in Settings → Model accounts.',
      };
    }
    if (isCredentialFailure(err)) {
      const envVar = credentialEnvVar(err);
      const who = options.agentName ? `${options.agentName} can't` : "I can't";
      const text =
        envVar === undefined
          ? `${who} reach the model: the provider refused the credential this machine is using. ` +
            'It has expired, or it is not allowed to use this model. Trying again will not help — ' +
            'the key in your .env has to be replaced, and buddi restarted.'
          : `${who} reach the model: the credential it needs is not set on this machine. ` +
            howToSet(envVar);
      return { class: 'permanent', text, retryable: false, detail };
    }
    const text =
      `That did not work, and trying again would fail in exactly the same way: ` +
      `${permanentReason(err)}. The details are in the log.`;
    return { class: 'permanent', text, retryable: false, detail };
  }

  return { class: 'unknown', text: UNKNOWN_TEXT, retryable: true, detail };
}

/**
 * The whole owner-facing message: the sentence for the class, plus the note
 * about work that already happened when there is one.
 *
 * A surface calls this, prints what comes back, and offers the retry only when
 * `offerRetry` is true. The two decisions are made here, once, rather than
 * three times in three surfaces that would drift apart.
 */
export interface RenderedFailure extends OwnerFailure {
  /** Offer "Try again" — retryable *and* nothing already ran. */
  offerRetry: boolean;
}

export function renderFailure(
  err: unknown,
  options: DescribeFailureOptions = {},
): RenderedFailure {
  const described = describeFailure(err, options);
  const toolsCalled = options.toolsCalled ?? 0;
  const withheld = described.retryable && toolsCalled > 0;
  return {
    ...described,
    text: withheld ? `${described.text}\n\n${retryWithheldText(toolsCalled)}` : described.text,
    offerRetry: described.retryable && toolsCalled === 0,
  };
}
