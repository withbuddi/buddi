/**
 * When a conversation ends.
 *
 * Until now, one never did. A Telegram chat's conversation with an agent was
 * created on first contact and then kept forever: `core.surface_conversations`
 * holds one row per (surface, chat, agent) and `ensureConversationForChat`
 * returns it for the rest of the installation's life. The dashboard is the same
 * shape by a different route — the page opens on the agent's most recent
 * conversation and sends into it — and the terminal keeps one per agent for the
 * length of the process.
 *
 * What that costs is not theoretical. On this installation, conversation
 * `187f53bf` was opened at 03:09 on the 14th and was still the live thread at
 * 20:39 on the 15th: 65 messages, 95k characters of transcript, and a turn
 * whose input was **64,177 tokens** — a day and a half of mail, bills and
 * drafts replayed to answer "can you draft a reply to Dorothee?". Every turn
 * was slower, more expensive and less focused than the one before it, and the
 * history included four questions the owner had long since moved on from.
 * `/reset` fixes it in one word, and requiring the owner to know that word is
 * the defect.
 *
 * ## The rule
 *
 * Two axes, OR-ed, both about the *previous* conversation and both evaluated
 * at the moment the owner says something — never in the middle of a turn:
 *
 *  1. **Idle.** More than `IDLE_TIMEOUT_MS` (three hours) since the last thing
 *     written in it. Three hours is the honest middle of the brief: finishing
 *     a thought ten minutes later must carry, and a message the next morning
 *     must not drag yesterday along. A gap that long is a different sitting —
 *     after lunch, after the school run, after sleep — and the few times it is
 *     genuinely the same subject, the owner says so in a sentence, which is
 *     cheaper than replaying a day to every turn in case they do.
 *  2. **Size.** More than `MAX_TRANSCRIPT_CHARS` (80k characters, roughly 20k
 *     tokens) of stored messages. This is the backstop for the runaway above,
 *     which never went three hours idle during a working day but grew to 95k
 *     characters. A transcript past this point is mostly things that already
 *     happened, and it is charged for on *every* turn.
 *
 * Neither axis ever fires mid-work: the check happens before a turn starts, so
 * a long run, a tool chain or an approval that is waiting is never cut in half.
 *
 * ## What a boundary is, and is not
 *
 * It is a new row in `core.conversations` and a fresh transcript. That is all.
 *
 *  - **Memory and the owner profile survive.** They are keyed by agent and by
 *    owner, not by conversation: `memoryPreamble` is asked for by agent id on
 *    every run, and the memory plugin's own tables are untouched here. What an
 *    agent has learned about the owner is not a property of a chat thread.
 *  - **An active computer/browser task survives size rollover.** The dashboard
 *    and Telegram composition roots transfer only that same agent's live task
 *    before adopting the new transcript, carrying bounded conversational text.
 *    Old evidence is invalidated and a fresh observation is mandatory. Pause,
 *    expiry and Stop still apply; explicit reset and idle rollover do not adopt
 *    control, and no host execution permission follows the task.
 *  - **What a browser session learned survives.** A session's observations are
 *    what pushes a transcript past the size limit in the first place, so the
 *    conversation after one starts with a single carried note — the task, the
 *    pages visited by URL and title, and the agent's last words — written as
 *    nobody speaking and drawn as a grey line, not a bubble. Page *content*
 *    never crosses: it is untrusted evidence gathered under the old request.
 *    See `browser-handoff.ts`.
 *  - **Pending approvals survive.** An action records the conversation that
 *    proposed it and the run resumes *that* conversation when the owner
 *    decides, whichever conversation the chat has moved on to. A boundary can
 *    no more strand an approval than `/reset` could.
 *  - **Offers do not.** An offer belongs to the turn that made it — the rule
 *    `withdrawOffers` already keeps within a conversation — and a boundary is
 *    the strongest possible version of "the owner moved on". So the old
 *    conversation's open offers are withdrawn as the new one starts, and a tap
 *    on one afterwards gets the ordinary "that option has expired — just ask me
 *    instead" rather than a run against a thread nobody is in.
 *  - **A pending question does not straddle one either.** It is a claim on the
 *    owner's *next message*, lives fifteen minutes, and belongs to the turn
 *    that asked. A surface answering one passes `continuation: true` so the
 *    answer lands where the question was asked; anything else clears it.
 *
 * ## The owner is not told, and does not need to be
 *
 * Every surface used to prepend one parenthesised line — "(New conversation —
 * we last spoke 6 days ago. What I remember about you carries over.)" — above
 * the answer. It is gone. Which transcript a reply was composed in is
 * bookkeeping: memory and the owner profile carry over by construction, so the
 * line announced a loss that did not happen, a few times a day, above answers
 * the owner had asked for. What is genuinely worth seeing is the *work* that
 * crossed, and the carry-over note already does that — drawn on the dashboard
 * as a grey "Carried over from the previous conversation" line, written into
 * the transcript for the agent, and written only when there was something to
 * carry. The dashboard's conversation header says the rest ambiently.
 *
 * The mechanics are untouched: the rollover happens, `start(boundary)` is
 * called, the carry-over is written, and the log still records every boundary.
 */
import { withdrawOffers, type Queryable } from '@buddi/core';
import { projectedTranscriptTokens, transcriptBudget } from './context-budget.js';

/** Silence longer than this ends a conversation. Three hours: a new sitting. */
export const IDLE_TIMEOUT_MS = 3 * 60 * 60_000;

/**
 * The floor under the size limit: the least transcript any conversation may
 * carry into a new turn, whatever its model.
 *
 * 80,000 characters is roughly 20k tokens of history before a word of the
 * answer is thought about. The runaway that motivated this was at 95k — a mail
 * thread, all text, where 80k is a generous amount of *conversation*.
 *
 * It is a floor and no longer a cap. A flat 80k was charged to every model
 * alike, and against a browser session it is nothing: one observation is a
 * page tree and a screenshot reference, several thousand characters, so a
 * dozen steps ended the conversation and the agent lost the task it was in the
 * middle of — while the 200k- or 1M-token window it was talking to stood idle.
 * The real limit is now a fraction of the bound model's window
 * (`surfaces/context-budget.ts`, `@buddi/runtime`'s `contextWindowTokens`),
 * measured against the *projected* transcript rather than the stored one,
 * because spent observations are reduced to a line before they are sent.
 */
export const MAX_TRANSCRIPT_CHARS = 80_000;

/** Why a conversation ended. Both are ordinary, neither is an error. */
export type LifetimeReason = 'idle' | 'size';

/** What the rule reads about a conversation. Facts, no policy. */
export interface ConversationVitals {
  /** Messages stored in it. Zero means nothing was ever said. */
  messages: number;
  /** The last thing written in it, or null when there is nothing. */
  lastActivityAt: Date | null;
  /** Total characters of stored message content. */
  chars: number;
  /**
   * What those messages cost the model, in tokens, once spent observations are
   * reduced to a line each — the number the size rule is really about. Absent
   * when nobody has asked (the stored count is one cheap aggregate; this one
   * reads every row), and the character count stands in for it then.
   */
  projectedTokens?: number | undefined;
}

export interface LifetimeLimits {
  idleMs?: number | undefined;
  /** The cheap precheck, against stored characters. */
  maxChars?: number | undefined;
  /** The real limit, against the projected transcript. */
  maxTokens?: number | undefined;
}

/**
 * Has this conversation ended? Pure, so the rule is testable without a clock
 * or a database.
 *
 * An empty conversation never ends: `buddi chat` opens one on start and the
 * dashboard's "new conversation" button makes one before anything is typed.
 * Rolling that over would mean a fresh install whose first message starts its
 * second conversation — a boundary nobody crossed.
 */
export function conversationExpiry(
  vitals: ConversationVitals,
  now: Date,
  limits: LifetimeLimits = {},
): LifetimeReason | null {
  if (vitals.messages <= 0 || vitals.lastActivityAt === null) return null;
  const idleMs = limits.idleMs ?? IDLE_TIMEOUT_MS;
  const maxChars = limits.maxChars ?? MAX_TRANSCRIPT_CHARS;
  const idle = now.getTime() - vitals.lastActivityAt.getTime();
  if (Number.isFinite(idle) && idle > idleMs) return 'idle';
  // What is *sent* is what costs, and it is charged in tokens: a transcript of
  // 300k stored characters whose spent observations reduce to 10k tokens has
  // outgrown nothing. Until somebody has projected it, the stored characters
  // are all there is to go on.
  if (vitals.projectedTokens !== undefined && limits.maxTokens !== undefined) {
    return vitals.projectedTokens > limits.maxTokens ? 'size' : null;
  }
  if (vitals.chars > maxChars) return 'size';
  return null;
}

/** The vitals of one conversation, in one statement. */
export async function readVitals(
  pool: Queryable,
  conversationId: string,
): Promise<ConversationVitals> {
  const { rows } = await pool.query(
    `select coalesce(count(m.id), 0) as messages,
            max(m.created_at) as last_at,
            coalesce(sum(length(m.content::text)), 0) as chars
       from core.conversations c
       left join core.messages m on m.conversation_id = c.id
      where c.id = $1
      group by c.id`,
    [conversationId],
  );
  const row = rows[0];
  if (!row) return { messages: 0, lastActivityAt: null, chars: 0 };
  return {
    messages: Number(row.messages ?? 0),
    lastActivityAt: row.last_at ? new Date(row.last_at) : null,
    chars: Number(row.chars ?? 0),
  };
}

export interface TurnConversationInput {
  /** The conversation this surface would otherwise have continued. */
  current?: string | undefined;
  /**
   * Start a conversation and adopt it. Surface-specific: Telegram repoints its
   * `core.surface_conversations` row, the terminal its per-agent map, the
   * dashboard hands the new id back to the page.
   */
  start: (boundary?: { previousConversationId: string; reason: LifetimeReason }) => Promise<string>;
  now: Date;
  /**
   * This message belongs to the previous turn — the owner answering a question
   * an agent asked them. A continuation is never cut off from the turn it
   * answers: an agent handed "7pm" with no memory of asking "what time?" is
   * the bug this whole lifetime is supposed to avoid, not cause.
   */
  continuation?: boolean | undefined;
  idleMs?: number | undefined;
  maxChars?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface TurnConversation {
  conversationId: string;
  /**
   * Present only when this turn opened a new conversation over an old one.
   * Surfaces act on it — clearing a pending question, handing the new id to
   * the page — but none of them says anything to the owner about it.
   */
  boundary?: {
    reason: LifetimeReason;
    previousConversationId: string;
  };
}

/**
 * The conversation this turn runs in.
 *
 * Total by construction: every database failure degrades to "carry on in the
 * conversation we had". A machine that cannot count a transcript must still
 * answer the owner, and continuing is the behaviour that existed before this
 * file.
 */
export async function conversationForTurn(
  pool: Queryable,
  input: TurnConversationInput,
): Promise<TurnConversation> {
  const current = input.current;
  if (current === undefined || current === '') {
    return { conversationId: await input.start() };
  }
  if (input.continuation === true) return { conversationId: current };

  // The limit is the model's, not a constant. A caller that names one (a test,
  // a surface with its own reason) is obeyed as is, in characters, the way it
  // always was.
  const budget = input.maxChars === undefined
    ? await transcriptBudget(pool, current).catch(() => null)
    : null;
  const maxChars = input.maxChars ?? budget?.precheckChars ?? MAX_TRANSCRIPT_CHARS;
  const maxTokens = budget?.maxTokens;

  let reason: LifetimeReason | null = null;
  let vitals: ConversationVitals = { messages: 0, lastActivityAt: null, chars: 0 };
  try {
    vitals = await readVitals(pool, current);
    reason = conversationExpiry(vitals, input.now, {
      ...(input.idleMs === undefined ? {} : { idleMs: input.idleMs }),
      maxChars,
    });
  } catch (err) {
    input.log?.(`conversation lifetime: reading ${current} failed: ${errorText(err)}`);
    return { conversationId: current };
  }
  // The stored count said it is over. That count includes page trees nobody
  // sends any more, so the decision is taken again on what is actually
  // projected — the cheap aggregate only decided whether to look. The
  // projection is cached against these same vitals, so a conversation that
  // sits over the character precheck is not re-read on every turn.
  if (reason === 'size' && maxTokens !== undefined) {
    const projected = await projectedTranscriptTokens(pool, current, vitals).catch(() => null);
    if (projected !== null) {
      vitals = { ...vitals, projectedTokens: projected };
      reason = conversationExpiry(vitals, input.now, {
        ...(input.idleMs === undefined ? {} : { idleMs: input.idleMs }),
        maxChars,
        maxTokens,
      });
    }
  }
  if (reason === null) return { conversationId: current };

  // The old conversation's buttons described a decision in a thread that is
  // over. Withdrawing is expiry, not deletion — a tap gets "that option has
  // expired" — and it is never allowed to cost the owner their answer.
  try {
    await withdrawOffers(pool, { conversationId: current, now: input.now });
  } catch (err) {
    input.log?.(`conversation lifetime: withdrawing offers of ${current} failed: ${errorText(err)}`);
  }

  const conversationId = await input.start({ previousConversationId: current, reason });
  // One line, with the reason and both sizes against the limit that was
  // applied: a conversation ending is a loss of context, and a loss nobody
  // can see in the log is a loss nobody can argue with.
  input.log?.(
    `conversation lifetime: ${current} ended (${reason}: ${vitals.messages} messages, ` +
      `${vitals.chars} stored chars` +
      `${vitals.projectedTokens === undefined ? '' : `, ${vitals.projectedTokens} projected tokens`}` +
      `, limit ${maxTokens === undefined ? `${maxChars} chars` : `${maxTokens} tokens`}` +
      `${budget?.model ? ` for ${budget.model} (${budget.windowTokens}-token window, ${budget.source})` : ''}` +
      `) — this turn runs in ${conversationId}`,
  );
  return {
    conversationId,
    boundary: { reason, previousConversationId: current },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
