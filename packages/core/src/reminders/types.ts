/**
 * Reminders — the one-off half of "an agent can put something on the clock".
 *
 * A mission is a standing schedule the owner (or, now, an approval) installed.
 * A reminder is a single instant an agent promised to look at: «remind me when
 * to pay the card». It needs no approval because it cannot *do* anything — it
 * wakes an agent with a note and the instruction to verify before speaking, and
 * the notify policy still decides whether the owner hears a word of it.
 *
 * What keeps that safe is not judgement but arithmetic: the limits below are
 * enforced in code, so the worst an agent can do with this tool is fill a small
 * fixed budget of future wake-ups, and the owner can see and cancel every one.
 */

export const REMINDER_STATES = ['pending', 'fired', 'cancelled', 'expired'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

/** At most this many pending reminders for one agent. */
export const MAX_PENDING_PER_AGENT = 10;

/** At most this many pending reminders across every agent. */
export const MAX_PENDING_TOTAL = 25;

/**
 * A reminder must be at least this far out.
 *
 * Not a rate limit: it is the line between a reminder and an answer. Something
 * due in the next minute or two is something the agent should simply say now,
 * and a nudge that lands while the owner is still reading the reply is noise.
 * Five minutes is the default line; `BUDDI_REMINDER_MIN_LEAD_MINUTES` moves it
 * (see `env.ts`). The firing loop ticks once a minute, so a reminder lands
 * within about a minute of its instant — which is why a lead this short still
 * means something.
 */
export const MIN_LEAD_MINUTES = 5;

/** And at most this far out. A year is already further than any promise holds. */
export const MAX_HORIZON_DAYS = 365;

/** The longest note a reminder carries. It is a nudge, not a report. */
export const MAX_REMINDER_TEXT = 500;

/**
 * How late is too late.
 *
 * The machine sleeps (docs/architecture.md, principle 3). A reminder found more than
 * this long past its instant is `expired`, not fired: "pay the card before
 * midnight" delivered at noon the next day is not a late reminder, it is a
 * wrong one.
 */
export const REMINDER_GRACE_MS = 24 * 60 * 60_000;

/**
 * The limits, as one object, so a caller (or a test) can tighten them — and so
 * `reminderLimitsFromEnv` can hand the installation's own numbers to the tool
 * and to its description in one piece.
 */
export interface ReminderLimits {
  maxPendingPerAgent: number;
  maxPendingTotal: number;
  minLeadMinutes: number;
  maxHorizonDays: number;
  maxTextChars: number;
}

export const DEFAULT_REMINDER_LIMITS: ReminderLimits = {
  maxPendingPerAgent: MAX_PENDING_PER_AGENT,
  maxPendingTotal: MAX_PENDING_TOTAL,
  minLeadMinutes: MIN_LEAD_MINUTES,
  maxHorizonDays: MAX_HORIZON_DAYS,
  maxTextChars: MAX_REMINDER_TEXT,
};

export interface Reminder {
  id: string;
  agentId: string;
  conversationId: string | null;
  dueAt: Date;
  text: string;
  /** Structured evidence the agent left for its future self. Never a command. */
  context: unknown;
  state: ReminderState;
  createdAt: Date;
  firedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

export type ReminderRow = {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  due_at: Date;
  text: string;
  context: unknown;
  state: ReminderState;
  created_at: Date;
  fired_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
};

export const REMINDER_COLUMNS =
  'id, agent_id, conversation_id, due_at, text, context, state, created_at, fired_at, cancelled_at, cancel_reason';

export function toReminder(row: ReminderRow): Reminder {
  return {
    id: String(row.id),
    agentId: row.agent_id,
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    dueAt: row.due_at,
    text: row.text,
    context: row.context ?? null,
    state: row.state,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
  };
}

/**
 * Why a reminder was not created.
 *
 * Every one of these is an expected outcome, not a defect: the tool hands the
 * message back to the model as a refusal it can act on ("ask me again nearer
 * the time", "you already have ten"), and nothing throws.
 */
export type ReminderRefusal =
  | 'invalid-when'
  | 'too-soon'
  | 'too-far'
  | 'empty-text'
  | 'text-too-long'
  | 'no-agent'
  | 'too-many-for-agent'
  | 'too-many';

export type CreateReminderResult =
  | { ok: true; reminder: Reminder }
  | { ok: false; reason: ReminderRefusal; message: string };
