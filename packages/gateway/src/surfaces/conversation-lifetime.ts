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
 * ## The owner can tell
 *
 * A boundary nobody can see is indistinguishable from amnesia. Every surface
 * says one line — `boundaryNote` — and says it once, above the answer: what
 * happened, why, and the reassurance that matters ("what I remember about you
 * carries over"). It is one line because this happens a few times a day, and
 * anything longer would become the noise the owner learns to skip.
 */
import { withdrawOffers, type Queryable } from '@buddi/core';

/** Silence longer than this ends a conversation. Three hours: a new sitting. */
export const IDLE_TIMEOUT_MS = 3 * 60 * 60_000;

/**
 * The most stored transcript one conversation may carry into a new turn.
 *
 * 80,000 characters is roughly 20k tokens of history before a word of the
 * answer is thought about. The runaway that motivated this was at 95k.
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
}

export interface LifetimeLimits {
  idleMs?: number | undefined;
  maxChars?: number | undefined;
}

/**
 * Has this conversation ended? Pure, so the rule is testable without a clock
 * or a database.
 *
 * An empty conversation never ends: `buddi chat` opens one on start and the
 * dashboard's "new conversation" button makes one before anything is typed.
 * Rolling that over would mean a fresh install whose first message starts its
 * second conversation, and a boundary note for a boundary nobody crossed.
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

/** "14 hours", "9 minutes", "2 days" — the gap, in the coarsest honest unit. */
export function sinceText(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The one line the owner reads when a conversation ends and another begins.
 *
 * Plain text, parenthesised, no markdown: it has to read the same on Telegram
 * (where a `*` is a `*`) as at a terminal. It says what happened and the one
 * thing the owner would otherwise have to guess — that this is a fresh
 * transcript, not a fresh agent.
 */
export function boundaryNote(
  reason: LifetimeReason,
  vitals: ConversationVitals,
  now: Date,
): string {
  const carries = 'What I remember about you carries over.';
  if (reason === 'idle' && vitals.lastActivityAt) {
    return `(New conversation — we last spoke ${sinceText(vitals.lastActivityAt, now)} ago. ${carries})`;
  }
  if (reason === 'idle') return `(New conversation — it had been a while. ${carries})`;
  return `(New conversation — the last one had grown long. ${carries})`;
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
  /** Present only when this turn opened a new conversation over an old one. */
  boundary?: {
    reason: LifetimeReason;
    previousConversationId: string;
    /** The line the surface shows the owner, once, above the answer. */
    note: string;
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

  let reason: LifetimeReason | null = null;
  let vitals: ConversationVitals = { messages: 0, lastActivityAt: null, chars: 0 };
  try {
    vitals = await readVitals(pool, current);
    reason = conversationExpiry(vitals, input.now, {
      ...(input.idleMs === undefined ? {} : { idleMs: input.idleMs }),
      ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
    });
  } catch (err) {
    input.log?.(`conversation lifetime: reading ${current} failed: ${errorText(err)}`);
    return { conversationId: current };
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
  input.log?.(
    `conversation lifetime: ${current} ended (${reason}: ${vitals.messages} messages, ` +
      `${vitals.chars} chars) — this turn runs in ${conversationId}`,
  );
  return {
    conversationId,
    boundary: {
      reason,
      previousConversationId: current,
      note: boundaryNote(reason, vitals, input.now),
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
