/**
 * What every surface does when a turn fails.
 *
 * There used to be five copies of one line — `Something went wrong: ${err.message}`
 * in the Telegram bubble, in the Telegram first run, `error: ${err.message}` at
 * the terminal prompt, and the raw string pushed onto the dashboard's stream —
 * and so there were five places to fix and five ways to drift. There is one
 * now, and it does three things in a fixed order:
 *
 *  1. **Write the truth to the log.** The whole cause chain, so that the next
 *     time something breaks there is something to read. `fetch failed` on its
 *     own taught us nothing across 129 occurrences and a working day.
 *  2. **Say something human to the owner.** `describeFailure` in core turns the
 *     verdict into sentences; nothing about the transport, the tool or the
 *     stack reaches the chat window.
 *  3. **Offer the obvious next step, when it is honest to.** A failed turn has
 *     exactly one: run it again. It is stored as an ordinary offer row and
 *     drawn by `renderOffers` from the surface's own profile — a button where
 *     there are buttons, a sentence where there are not — so this invents no
 *     second button path.
 *
 * ## When a retry is *not* offered
 *
 * Two cases, both deliberate.
 *
 * **A permanent failure.** An expired credential will be exactly as expired on
 * the second attempt. A button that cannot work is worse than no button.
 *
 * **A turn that had already called a tool.** By the time the provider call
 * failed, those calls had run and their results were written to the
 * transcript. Re-sending the owner's message would ask the agent to do that
 * work again, and we cannot know from here whether doing it twice is harmless
 * — two reminders is not the same as one. Anything with an effect outside this
 * machine was gated and stopped the run before it executed, so this is never
 * about an email sent twice; it is about not repeating local work behind a
 * button nobody was warned about. The owner is told what already happened and
 * asked how to carry on, which is a worse button and a better answer.
 *
 * ## What a retry runs
 *
 * The owner's message, verbatim — not a summary of it, not a paraphrase, and
 * not the first 500 characters of it (`maxPromptChars` is raised for exactly
 * this). It is the same agent, and the run it starts has the same tools, the
 * same tiers and the same approvals: taking a retry authorizes nothing that
 * typing the message again would not have.
 */
import {
  MAX_OFFER_PROMPT,
  offerActions,
  renderFailure,
  renderOffers,
  RETRY_OFFER_LABEL,
  type FailureClass,
  type Offer,
  type Queryable,
  type RenderedOffers,
  type SurfaceProfile,
} from '@buddi/core';

/** The longest owner message a "Try again" offer will carry back verbatim. */
export const MAX_RETRY_PROMPT_CHARS = 8000;

export interface FailedTurn {
  /** What was thrown. Never rendered; classified and logged. */
  error: unknown;
  /** The surface's declared profile — it decides buttons versus words. */
  profile: SurfaceProfile;
  /** The agent whose turn it was. A retry belongs to it and to nobody else. */
  agentId: string;
  /** How that agent is named out loud, e.g. `@postman`. */
  agentName?: string | undefined;
  /** Where a retry offer would live. Absent: no offer is stored. */
  conversationId?: string | undefined;
  /** The owner's own message, verbatim. Absent: no offer is stored. */
  prompt?: string | undefined;
  /** How many tools the failed attempt called. See the header. */
  toolsCalled?: number | undefined;
  now: Date;
  log?: ((line: string) => void) | undefined;
}

export interface FailureOutcome {
  /** The text and controls this surface should send. */
  rendered: RenderedOffers;
  /** The whole cause chain. Already logged; recorded on the surface event. */
  detail: string;
  failureClass: FailureClass;
  /** The retry offer, when one was stored. */
  offer: Offer | undefined;
}

/**
 * Turn a thrown error into what the owner sees, and store the retry if one is
 * honest.
 *
 * Total: it is called from `catch` blocks, so a failure in here would be a
 * second failure on top of the first. Storing the offer is allowed to fail —
 * that costs a button, never the message.
 */
export async function failedTurnReply(
  pool: Queryable,
  turn: FailedTurn,
): Promise<FailureOutcome> {
  const failure = renderFailure(turn.error, {
    agentName: turn.agentName,
    toolsCalled: turn.toolsCalled,
  });

  const where = turn.agentName ? `${turn.agentName}: ` : '';
  turn.log?.(`run failed [${failure.class}] ${where}${failure.detail}`);

  const prompt = (turn.prompt ?? '').trim();
  const wanted =
    failure.offerRetry && prompt !== '' && turn.conversationId !== undefined;

  let offer: Offer | undefined;
  if (wanted) {
    try {
      const stored = await offerActions(pool, {
        agentId: turn.agentId,
        conversationId: turn.conversationId as string,
        actions: [{ label: RETRY_OFFER_LABEL, prompt }],
        now: turn.now,
        maxPromptChars: Math.max(MAX_OFFER_PROMPT, MAX_RETRY_PROMPT_CHARS),
      });
      offer = stored[0];
    } catch (err) {
      // A turn that failed and could not store its retry is a turn that failed.
      turn.log?.(`offers: storing the retry for a failed turn failed: ${message(err)}`);
    }
  }

  return {
    rendered: renderOffers(turn.profile, failure.text, offer ? [offer] : []),
    detail: failure.detail,
    failureClass: failure.class,
    offer,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
