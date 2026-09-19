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

/**
 * Environment variables whose absence has a specific cure worth naming.
 *
 * Not a list of every credential — just the two an Anthropic install actually
 * uses, because "run claude setup-token" is a real instruction and "set the
 * credential" is not.
 */
function howToSet(envVar: string): string {
  if (/OAUTH_TOKEN$/.test(envVar)) {
    return `Run "claude setup-token", put what it gives you in ${envVar} in your .env, and restart buddi.`;
  }
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
  const verdict = classifyFailure(err);

  if (verdict.class === 'transient') {
    return { class: 'transient', text: TRANSIENT_TEXT, retryable: true, detail };
  }

  if (verdict.class === 'permanent') {
    if (typeof err === 'object' && err !== null && (err as Record<string, unknown>).type === 'model_not_supported') {
      return { class: 'permanent', retryable: false, detail,
        text: 'The selected model is not available for this provider account. Open agent settings and choose a model supported by the assigned account, then send your message again.' };
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
