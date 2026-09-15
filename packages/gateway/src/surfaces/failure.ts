/**
 * What every surface does when a turn fails.
 *
 * There used to be five copies of one line — `Something went wrong: ${err.message}`
 * in the Telegram bubble, in the Telegram first run, `error: ${err.message}` at
 * the terminal prompt, and the raw string pushed onto the dashboard's stream —
 * and so there were five places to fix and five ways to drift. There is one
 * now, and it does four things in a fixed order:
 *
 *  0. **Close the turn in the transcript.** See `closeFailedTurn` below: the
 *     owner's message is persisted *before* the provider is called, so a run
 *     that dies leaves a question sitting in the history with nothing after it
 *     — and the next run that succeeds reads it as work it still owes.
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

/* ------------------------------------------------------------------ *
 * Closing the turn in the transcript
 * ------------------------------------------------------------------ */

/**
 * What a failed turn leaves behind, and why it has to be closed.
 *
 * `runAgent` persists the owner's message before it calls the provider — it
 * must, because a message the owner sent is a fact whether or not the answer
 * arrives. When the provider call then dies, the transcript ends on a turn of
 * the owner's with nothing after it, and `loadMessages` hands that to the next
 * run as ordinary history. The next run reads an unanswered question and does
 * the obvious thing: it answers it.
 *
 * That is not a hypothetical either. On this installation, conversation
 * `187f53bf` collected four dead turns on the afternoon of the 15th — "Can you
 * draft a response to Parfait Sedjro last mail of today?", "hi", "draft a reply
 * to Parfait Sedjro", plus a tool result nobody consumed — each shown to the
 * owner as `Something went wrong: fetch failed`. At 20:39 he asked about a
 * different person entirely, the run succeeded, and it opened by explaining at
 * length that no mail from Parfait Sedjro could be found. He had asked that
 * three hours earlier and been told it failed.
 *
 * ## The honest representation
 *
 * Not deletion: removing his message would make the record lie in the other
 * direction, and the dashboard would show a failure notice for a message that
 * is not there. Not silent exclusion either — a history the model reads and a
 * history the owner reads that disagree is a bug waiting to be diagnosed twice.
 *
 * So the turn is *closed*: one assistant message saying the turn failed, that
 * the owner was told, and that the message above was not answered. It is true
 * — the surface did put that sentence in front of him — it is the same thing
 * the owner sees, and it reads to a later run as a turn that is over rather
 * than as work outstanding.
 *
 * ## Tool calls that never came back
 *
 * A run can also die between a tool_use and its result (the 17:33 turn above
 * did). The API requires one result per tool_use, so the close answers each
 * dangling call with an error result before the marker — otherwise the next
 * run sends a transcript the provider rejects outright.
 *
 * ## The retry is unaffected
 *
 * "Try again" carries the owner's own sentence into a **fresh** conversation
 * (`agent-run` creates one for every taken offer), so closing the old turn
 * takes nothing away from the button: the one case where the question *should*
 * be answered is the case where the owner asked for it a second time.
 */

/** What closing found, and did. Returned for the log and for tests. */
export type TurnClosure = 'closed' | 'closed-with-tool-results' | 'answered' | 'empty' | 'failed';

/**
 * The marker a closed turn leaves in the transcript.
 *
 * Written in the second person because a person reads it on the dashboard, and
 * in plain words because a later run reads it as history: it says the message
 * above was not answered *and* that it is not to be answered now.
 */
export function failedTurnMarker(opts: { retryOffered: boolean }): string {
  return (
    '(This turn failed before I could answer, and you were shown the error' +
    (opts.retryOffered ? ' with the option to try it again' : '') +
    '. It is closed: I did not answer the message above and will not, unless you ask again.)'
  );
}

/** The result a dangling tool_use is answered with, so the transcript stays valid. */
export const ABANDONED_TOOL_RESULT =
  'the run failed before this call came back; its result was never seen';

interface Block {
  type?: string;
  id?: string;
}

/**
 * Close whatever this failed run left open in `conversationId`.
 *
 * Never throws: it is called from a `catch`, and a transcript that could not be
 * closed is still a turn the owner has to be told about.
 */
export async function closeFailedTurn(
  pool: Queryable,
  input: {
    conversationId: string;
    retryOffered: boolean;
    log?: ((line: string) => void) | undefined;
  },
): Promise<TurnClosure> {
  try {
    const { rows } = await pool.query(
      `select role, content from core.messages
        where conversation_id = $1
        order by created_at desc, id desc
        limit 1`,
      [input.conversationId],
    );
    const last = rows[0];
    // Nothing was written: the run died before it persisted anything, so there
    // is nothing hanging and nothing to say.
    if (!last) return 'empty';

    const blocks = normalizeBlocks(last.content);
    const marker = [{ type: 'text', text: failedTurnMarker({ retryOffered: input.retryOffered }) }];

    if (last.role === 'assistant') {
      const calls = blocks.filter((b) => b.type === 'tool_use' && typeof b.id === 'string');
      // An assistant turn that said its piece answered the owner. Nothing is
      // hanging, and a marker would be a failure report for a turn that worked.
      if (calls.length === 0) return 'answered';
      await persist(pool, input.conversationId, 'user', calls.map((call) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: ABANDONED_TOOL_RESULT,
        is_error: true,
      })));
      await persist(pool, input.conversationId, 'assistant', marker);
      return 'closed-with-tool-results';
    }

    // A user turn with nothing after it: the owner's message, or the tool
    // results the dead run never got to read. Either way, the turn is over.
    await persist(pool, input.conversationId, 'assistant', marker);
    return 'closed';
  } catch (err) {
    input.log?.(`closing the failed turn in ${input.conversationId} failed: ${message(err)}`);
    return 'failed';
  }
}

function normalizeBlocks(raw: unknown): Block[] {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  return Array.isArray(value) ? (value as Block[]) : [];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function persist(
  pool: Queryable,
  conversationId: string,
  role: 'user' | 'assistant',
  content: unknown,
): Promise<void> {
  await pool.query(
    `insert into core.messages (conversation_id, role, content)
     values ($1, $2, $3::jsonb)`,
    [conversationId, role, JSON.stringify(content)],
  );
}

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
  /** What closing the turn in the transcript found. See `closeFailedTurn`. */
  closure: TurnClosure | undefined;
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

  // Last, because it depends on whether a retry was stored: the marker tells
  // the owner exactly what they were shown. Only when there is a conversation
  // to close — a first-run greeting that failed has a conversation, a run that
  // never had one (a missing credential, before anything was written) does not.
  const closure =
    turn.conversationId === undefined
      ? undefined
      : await closeFailedTurn(pool, {
          conversationId: turn.conversationId,
          retryOffered: offer !== undefined,
          log: turn.log,
        });

  return {
    rendered: renderOffers(turn.profile, failure.text, offer ? [offer] : []),
    detail: failure.detail,
    failureClass: failure.class,
    offer,
    closure,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
