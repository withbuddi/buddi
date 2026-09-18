/**
 * "The agent that asked owns the answer."
 *
 * A one-shot mention — `@buddi remind me tonight to move the sites` — runs one
 * agent for one message and leaves the chat on whoever it was talking to. That
 * is right when the answer ends the matter. It is wrong when the answer is a
 * *question*, because the agent that asked has no claim on the reply: the owner
 * types "7pm", and it lands on an agent that never asked anything.
 *
 * That is not hypothetical. It is how a reminder to move two websites off
 * Cloudways was silently lost: @buddi asked "what time tonight?", the answer
 * went to @postman, and @postman correctly said it had no idea what 7pm meant.
 *
 * So: an agent that ends a one-shot turn asking the owner something owns the
 * owner's next message, and then the chat goes back to whoever was active.
 *
 * ## How "it asked a question" is decided
 *
 * Two signals, OR-ed, in this order of authority:
 *
 *  1. **The agent says so.** `conversation.ask` is registered for interactive
 *     turns the way `mission.report` is registered for unattended ones: the run
 *     declares what it did rather than leaving the surface to infer it from
 *     prose. It catches the cases no text rule can — "tell me which card",
 *     "I need the account number before I can do this" — because those are
 *     questions in intent and imperatives in grammar.
 *  2. **A deliberately narrow text fallback** (`endedWithQuestion`). Models
 *     forget tools, and a missed capture is exactly the failure being fixed —
 *     a silently stranded task — while a wrong capture costs one message
 *     delivered to the wrong agent, which the owner can see and redo. The
 *     asymmetry is the whole justification for having a fallback at all, and
 *     it is why the fallback is tight rather than clever (see below).
 *
 * ## How long it lasts
 *
 * A pending question survives exactly **one owner message**, and at most
 * **fifteen minutes**. If the captured turn ends in another question it is
 * renewed, up to three consecutive captures. Any message that is not an answer
 * — a slash command, a mention of a third agent, a file, a fresh request —
 * both escapes the capture and ends it: the owner has moved on, and an agent
 * does not get to hold the chat because it once asked something.
 *
 * Kept in memory, per chat. A restart drops it, which fails to the old
 * behaviour rather than to a wrong one.
 */
import {
  MAX_QUESTION_LABEL,
  MAX_QUESTION_OPTIONS,
  type PluginManifest,
  type QuestionOption,
  type ToolDefinition,
} from '@buddi/core';
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * The explicit signal
 * ------------------------------------------------------------------ */

/** Plugin family name for the interactive-turn tools. */
export const ASK_PLUGIN = 'conversation';

/** The one tool: "I am ending this turn by asking the owner something." */
export const ASK_TOOL = 'conversation.ask';

/** Added to an agent's tool list for an interactive turn, and only there. */
export const ASK_TOOLS: readonly string[] = [ASK_TOOL];

/** The longest question worth recording. Presentation never uses it. */
export const MAX_QUESTION_CHARS = 300;

/** Where the tool records that this turn ended on a question. One per run. */
export interface AskSink {
  asked?: {
    question: string;
    options: Array<Omit<QuestionOption, 'id'>>;
    allowOther: boolean;
  };
}

const askInput = z.object({
  question: z
    .string()
    .min(1)
    .max(MAX_QUESTION_CHARS)
    .describe(
      'The question you are asking the owner, in one line. You still write it out in your reply as well — this is the declaration, not the delivery.',
    ),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(MAX_QUESTION_LABEL),
        hint: z.string().max(120).optional(),
        recommended: z.boolean().optional(),
      }),
    )
    .max(MAX_QUESTION_OPTIONS)
    .optional()
    .describe('Likely answers as quick choices. Put the best default first and mark it recommended. Leave empty only for a genuinely open-ended answer.'),
  allowOther: z
    .boolean()
    .optional()
    .describe('Whether the owner may type a different answer. Keep true unless only the listed values are valid.'),
});

export type AskResult = { pending: true };

/**
 * The `conversation.ask` manifest, bound to one run's sink.
 *
 * Registered per run into a copy of the base registry, exactly as the mission
 * tools are: nothing outside an interactive turn can call it, and two chats
 * never share a sink.
 */
export function createAskManifest(sink: AskSink): PluginManifest {
  const ask: ToolDefinition<z.infer<typeof askInput>, AskResult> = {
    name: ASK_TOOL,
    description:
      "Declare that you are ending this turn by asking the owner something you need them to answer. Call it once, just before you finish, whenever your reply leaves a decision with them — a time, a choice, a missing detail — including when you phrase it as an instruction ('tell me which card'). It sends nothing and authorizes nothing: it only tells this chat that the owner's next message is an answer to you, so their reply reaches you rather than whichever agent they were talking to before.",
    tier: 'auto',
    input: askInput,
    async execute(input) {
      sink.asked = {
        question: input.question.trim(),
        options: (input.options ?? []).map((option) => ({
          label: option.label.trim(),
          hint: option.hint?.trim() || null,
          recommended: option.recommended === true,
        })),
        allowOther: input.allowOther ?? true,
      };
      return { pending: true };
    },
  };

  return {
    name: ASK_PLUGIN,
    version: '0.1.0',
    // No schema of its own: the question lives in the run for the length of
    // the run, and the routing decision it feeds is in-memory per chat.
    schema: 'core',
    migrationsDir: '',
    tools: [ask],
  };
}

/** The instruction block that tells an interactive turn the tool exists. */
export const ASK_POLICY_SUFFIX = [
  `${ASK_TOOL} is Buddi's AskUserQuestion tool. If the owner calls it AskUserQuestion, AskQuestion, a quick question, or an inline keyboard, they mean ${ASK_TOOL}; do not tell them that tool is unavailable.`,
  `When you need the owner to choose, clarify, confirm a preference, or supply a missing detail before you can finish, call ${ASK_TOOL}.`,
  `Prefer ${ASK_TOOL} with 2–5 short options whenever the likely answers are known: the dashboard and Telegram turn them into one-tap choices. Put the choice you recommend first, mark it recommended, and explain why in its hint.`,
  'Ask one decision at a time unless the questions are independent. Do not ask for something you can safely read or determine yourself, and do not interrupt for a low-impact reversible choice you can state as an assumption.',
  'Call it for a request phrased as an instruction too ("tell me which card"), because that is still a question.',
  'Do not call it for an open-ended discussion, a question you answer yourself, a question you are quoting, or a closing pleasantry.',
  `If the owner explicitly asks to test or demonstrate AskUserQuestion, that request itself is a valid reason to call ${ASK_TOOL}: ask one harmless bounded question with 2–5 choices so they can see the interaction.`,
  'Never use it to obtain permission for an effect. Permission is a separate approval bound to the exact action.',
  'Call it before writing the reply, then ask the same concise question in the reply without spelling out options the surface will draw.',
  'It delivers nothing and authorizes nothing; it records the question and makes sure the answer comes back to you.',
].join(' ');

/* ------------------------------------------------------------------ *
 * The text fallback
 * ------------------------------------------------------------------ */

/** Longer than this and a trailing `?` is prose, not a request for input. */
const MAX_QUESTION_LINE = 200;

/**
 * An opener that makes a final `?` a genuine request for the owner's input.
 * Deliberately a whitelist: everything not on it is not a question for these
 * purposes, however it is punctuated.
 */
const INTERROGATIVE =
  /^(what|when|which|who|whom|whose|where|how|do|does|did|can|could|should|shall|would|will|is|are|was|were|have|has|had|may|might|want|shall)\b/i;

/** Second person: "your", "you'd", "you". A question *to the owner*. */
const SECOND_PERSON = /\byou\b|\byou'(?:d|ll|re|ve)\b|\byour\b|\byours\b/i;

/**
 * Did this reply end by asking the owner something?
 *
 * The conservative reading of a naive trailing-`?` test, which both over-fires
 * (a rhetorical aside, a question inside a quoted email) and under-fires (an
 * imperative clarification). Every condition must hold:
 *
 *  - the reply's **last** non-empty line ends with `?` — a question in the
 *    middle is something the agent went on to answer itself;
 *  - that line is not quoted: no leading `>`, not wrapped in quotation marks,
 *    not inside a fenced code block;
 *  - it is short (a 200-character paragraph ending in `?` is prose);
 *  - and it either opens with an interrogative word or speaks to the owner in
 *    the second person, which is what separates "what time tonight?" from
 *    "who knows what the bank will do next?".
 *
 * The imperative clarification ("tell me which card") is deliberately *not*
 * matched here. There is no honest text rule for it, and that is what the
 * `conversation.ask` tool exists to catch.
 */
export function endedWithQuestion(reply: string): boolean {
  const text = reply.replace(/\r/g, '').trimEnd();
  if (text === '') return false;

  // A fenced block at the end is code or a quoted document, never a question.
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 === 1) return false;

  const lines = text.split('\n');
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line !== '') {
      // Walking back out of a closing fence would read the code inside it.
      if (line.startsWith('```')) return false;
      last = line;
      break;
    }
  }
  if (!last.endsWith('?')) return false;
  if (last.length > MAX_QUESTION_LINE) return false;
  if (last.startsWith('>')) return false;
  // "She asked: 'can you do it by Friday?'" — somebody else's question.
  if (/^["“'‘]/.test(last)) return false;
  if (last.startsWith('*') || last.startsWith('_')) return false;

  const body = last.replace(/^[-*\d.\s)]+/, '');
  return INTERROGATIVE.test(body) || SECOND_PERSON.test(body);
}

/**
 * Did this turn end on a question, by either signal?
 *
 * `declared` is what the run reported (the tool), `reply` is what it wrote.
 * OR-ed on purpose: the declaration is authoritative when it is present, and
 * the text rule is the safety net for a run that never declared anything —
 * including a surface where the tool is not wired at all.
 */
export function turnAskedOwner(declared: boolean | undefined, reply: string): boolean {
  return declared === true || endedWithQuestion(reply);
}

/* ------------------------------------------------------------------ *
 * The pending question
 * ------------------------------------------------------------------ */

/** How long an unanswered question keeps its claim on the next message. */
export const PENDING_TTL_MS = 15 * 60_000;

/** How many consecutive owner messages one agent may capture this way. */
export const MAX_CAPTURES = 3;

export interface PendingQuestion {
  /** The agent that asked, and now owns the answer. */
  askedAgentId: string;
  askedAgentName: string;
  /** The agent the chat was talking to, and will go back to. */
  previousAgentId: string;
  previousAgentName: string;
  /** When the question was asked. */
  at: number;
  /** How many owner messages this question has already taken. */
  captures: number;
}

/** Why a message did not go to the agent that asked. Logged, never shown. */
export type EscapeReason =
  | 'none'
  | 'expired'
  | 'exhausted'
  | 'command'
  | 'mention'
  | 'fresh-request'
  | 'too-long';

/**
 * A message that plainly starts a new job rather than answering one.
 *
 * Narrow on purpose. The bar is "the owner is obviously asking for something
 * new", not "this might not be an answer": an answer misrouted to the active
 * agent is the bug, and the owner's own words are usually short and blunt
 * ("7pm", "the blue one", "yes do that"). Question words are *not* here — an
 * owner who answers with a question of their own is still answering.
 */
const FRESH_REQUEST =
  /^(please\s+|now\s+)?(remind|schedule|book|send|email|forward|reply|draft|write|pay|transfer|call|text|cancel|delete|remove|create|make|add|deploy|restart|deploy|install|search|find|look\s+up|open|start|stop|run|check\s+my|show\s+me|give\s+me|tell\s+me\s+about|can\s+you|could\s+you|i\s+need\s+you\s+to|help\s+me)\b/i;

/** Beyond this a message is a briefing, not an answer to one question. */
export const MAX_ANSWER_CHARS = 240;

/**
 * Would this text be read as the answer to a question the owner was asked?
 *
 * The two hard escapes come first and are absolute, as the routing rules
 * require: a slash command and an explicit `@handle` always win over a pending
 * question. (Both are recognised here by shape rather than by importing the
 * surface's parsers — a leading `/` or `@word` is the whole test, and the
 * module that decides routing must not depend on one surface's grammar.)
 */
export function answerVerdict(text: string): EscapeReason {
  const trimmed = text.trim();
  if (trimmed === '') return 'fresh-request';
  if (trimmed.startsWith('/')) return 'command';
  if (/^@[A-Za-z][\w-]*/.test(trimmed)) return 'mention';
  if (trimmed.length > MAX_ANSWER_CHARS) return 'too-long';
  if (FRESH_REQUEST.test(trimmed)) return 'fresh-request';
  return 'none';
}

/**
 * The pending questions of every chat on one surface.
 *
 * One instance per surface object; the key is whatever that surface calls a
 * conversation (a Telegram chat id, the single CLI session).
 */
export class PendingQuestions {
  readonly #open = new Map<string, PendingQuestion>();
  readonly #ttl: number;
  readonly #maxCaptures: number;

  constructor(opts: { ttlMs?: number; maxCaptures?: number } = {}) {
    this.#ttl = opts.ttlMs ?? PENDING_TTL_MS;
    this.#maxCaptures = opts.maxCaptures ?? MAX_CAPTURES;
  }

  /** Record that `asked` ended a one-shot turn asking the owner something. */
  open(
    key: string,
    question: Omit<PendingQuestion, 'captures'> & { captures?: number },
  ): void {
    this.#open.set(key, { captures: 0, ...question });
  }

  peek(key: string): PendingQuestion | undefined {
    return this.#open.get(key);
  }

  /** The owner moved on, switched agent, or sent a file. */
  clear(key: string): void {
    this.#open.delete(key);
  }

  /**
   * Decide where this message goes, and settle the pending question either way.
   *
   * Returns the question whose asker should run, or `undefined` with the reason
   * it escaped. Escaping *always* ends the pending question: it captures the
   * next message or it dies.
   */
  claim(
    key: string,
    text: string,
    now: number,
  ): { pending: PendingQuestion } | { pending: undefined; reason: EscapeReason } {
    const open = this.#open.get(key);
    if (!open) return { pending: undefined, reason: 'none' };

    if (now - open.at > this.#ttl) {
      this.#open.delete(key);
      return { pending: undefined, reason: 'expired' };
    }
    if (open.captures >= this.#maxCaptures) {
      this.#open.delete(key);
      return { pending: undefined, reason: 'exhausted' };
    }
    const verdict = answerVerdict(text);
    if (verdict !== 'none') {
      this.#open.delete(key);
      return { pending: undefined, reason: verdict };
    }

    // Taken, not yet finished: `settle` decides whether it is renewed.
    this.#open.delete(key);
    return { pending: { ...open, captures: open.captures + 1 } };
  }

  /**
   * The captured turn is over. `askedAgain` renews the claim for one more
   * message; anything else hands the chat back to the previous agent.
   */
  settle(key: string, taken: PendingQuestion, askedAgain: boolean, now: number): void {
    if (!askedAgain) return;
    if (taken.captures >= this.#maxCaptures) return;
    this.#open.set(key, { ...taken, at: now });
  }
}

/* ------------------------------------------------------------------ *
 * What the owner reads
 * ------------------------------------------------------------------ */

/**
 * The line that says where the answer landed.
 *
 * Deliberately the shape the surface already uses for `/status` — "(X answered
 * this one; you are still talking to Y.)" — because the owner has read that
 * sentence before and it means exactly this: somebody other than the active
 * agent spoke, and the chat has not changed hands.
 */
export function capturedNote(
  taken: PendingQuestion,
  opts: { stillAsking: boolean },
): string {
  return opts.stillAsking
    ? `(${taken.askedAgentName} asked that, so your answer went there — and is still waiting on you. ${taken.previousAgentName} is next after this.)`
    : `(${taken.askedAgentName} asked that, so your answer went there; you are back with ${taken.previousAgentName} now.)`;
}
