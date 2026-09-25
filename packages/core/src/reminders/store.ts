/**
 * The reminder store. Every limit lives here, in SQL or in arithmetic — never
 * in a prompt, and never in an agent's judgement.
 *
 * `createReminder` is one INSERT whose WHERE clause *is* the budget: the two
 * pending counts are subqueries in the same statement, so two runs racing to
 * take the last slot produce one reminder and one refusal rather than eleven
 * rows. When it inserts nothing, the counts are read back to say which limit
 * was reached — an answer the model can act on, not an error.
 */
import type { Queryable } from '../owner.js';
import { localDateTimeString } from '../time.js';
import {
  DEFAULT_REMINDER_LIMITS,
  REMINDER_COLUMNS,
  REMINDER_GRACE_MS,
  toReminder,
  type CreateReminderResult,
  type Reminder,
  type ReminderLimits,
  type ReminderRow,
  type ReminderState,
} from './types.js';

export interface CreateReminderInput {
  agentId: string;
  /** The instant it fires. Resolve a written `when` with `parseReminderWhen`. */
  dueAt: Date;
  text: string;
  /** Structured evidence for the future run. Recorded verbatim, never obeyed. */
  context?: unknown;
  /** Where it was promised. Provenance only. */
  conversationId?: string | null;
  now: Date;
  /** The owner's zone — only ever used to render a refusal in their terms. */
  timezone: string;
  limits?: Partial<ReminderLimits>;
}

/**
 * Put one reminder on the clock, or say why not.
 *
 * Never throws for an expected condition: every limit comes back as a typed
 * refusal carrying a sentence the model can repeat to the owner.
 */
export async function createReminder(
  pool: Queryable,
  input: CreateReminderInput,
): Promise<CreateReminderResult> {
  const limits: ReminderLimits = { ...DEFAULT_REMINDER_LIMITS, ...(input.limits ?? {}) };

  const agentId = (input.agentId ?? '').trim();
  if (agentId === '') {
    return {
      ok: false,
      reason: 'no-agent',
      message: 'a reminder belongs to the agent that set it, and this run has no agent id',
    };
  }

  const text = (input.text ?? '').trim();
  if (text === '') {
    return { ok: false, reason: 'empty-text', message: 'a reminder needs text to carry' };
  }
  if (text.length > limits.maxTextChars) {
    return {
      ok: false,
      reason: 'text-too-long',
      message: `a reminder is at most ${limits.maxTextChars} characters; this one is ${text.length}`,
    };
  }

  if (Number.isNaN(input.dueAt.getTime())) {
    return { ok: false, reason: 'invalid-when', message: 'that is not a valid date and time' };
  }

  const leadMs = input.dueAt.getTime() - input.now.getTime();
  if (leadMs < limits.minLeadMinutes * 60_000) {
    return {
      ok: false,
      reason: 'too-soon',
      message:
        `a reminder has to be at least ${limits.minLeadMinutes} minutes out; ` +
        `${localDateTimeString(input.dueAt, input.timezone)} is sooner than that. ` +
        'Say it now instead, or pick a later time.',
    };
  }
  if (leadMs > limits.maxHorizonDays * 24 * 60 * 60_000) {
    return {
      ok: false,
      reason: 'too-far',
      message: `a reminder can be at most ${limits.maxHorizonDays} days out`,
    };
  }

  const { rows } = await pool.query(
    `insert into core.reminders (agent_id, conversation_id, due_at, text, context)
     select $1::text, $2::uuid, $3::timestamptz, $4::text, $5::jsonb
     where (select count(*) from core.reminders where state = 'pending' and agent_id = $1) < $6
       and (select count(*) from core.reminders where state = 'pending') < $7
     returning ${REMINDER_COLUMNS}`,
    [
      agentId,
      input.conversationId ?? null,
      input.dueAt.toISOString(),
      text,
      input.context === undefined ? null : JSON.stringify(input.context),
      limits.maxPendingPerAgent,
      limits.maxPendingTotal,
    ],
  );

  if (rows.length > 0) {
    return { ok: true, reminder: toReminder(rows[0] as ReminderRow) };
  }

  // Nothing inserted: one of the two budgets is full. Which one decides the
  // sentence, because "cancel one of yours" and "the whole installation is
  // full" are different instructions.
  const counts = await pool.query(
    `select
       count(*) filter (where agent_id = $1) as mine,
       count(*) as total
     from core.reminders where state = 'pending'`,
    [agentId],
  );
  const mine = Number(counts.rows[0]?.mine ?? 0);
  if (mine >= limits.maxPendingPerAgent) {
    return {
      ok: false,
      reason: 'too-many-for-agent',
      message: `you already have ${mine} reminders pending, which is the limit (${limits.maxPendingPerAgent}). Cancel one first.`,
    };
  }
  return {
    ok: false,
    reason: 'too-many',
    message: `this installation already has ${Number(
      counts.rows[0]?.total ?? 0,
    )} reminders pending, which is the limit (${limits.maxPendingTotal}).`,
  };
}

export interface ListRemindersInput {
  agentId?: string;
  state?: ReminderState;
  limit?: number;
}

/** Reminders, soonest first. Unfiltered it is every state, for the owner's list. */
export async function listReminders(
  pool: Queryable,
  input: ListRemindersInput = {},
): Promise<Reminder[]> {
  const { rows } = await pool.query(
    `select ${REMINDER_COLUMNS} from core.reminders
      where ($1::text is null or agent_id = $1)
        and ($2::text is null or state = $2)
      order by due_at, id
      limit $3`,
    [input.agentId ?? null, input.state ?? null, Math.max(1, Math.min(input.limit ?? 50, 200))],
  );
  return rows.map((row) => toReminder(row as ReminderRow));
}

/** One reminder by id, or null. */
export async function getReminder(pool: Queryable, id: string): Promise<Reminder | null> {
  const { rows } = await pool.query(
    `select ${REMINDER_COLUMNS} from core.reminders where id = $1::uuid`,
    [id],
  );
  return rows.length > 0 ? toReminder(rows[0] as ReminderRow) : null;
}

/**
 * Cancel a pending reminder. Idempotent by construction: the guard is
 * `state = 'pending'`, so cancelling a fired one changes nothing and says so by
 * returning null.
 */
export async function cancelReminder(
  pool: Queryable,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<Reminder | null> {
  const { rows } = await pool.query(
    `update core.reminders
        set state = 'cancelled', cancelled_at = $3::timestamptz, cancel_reason = $2
      where id = $1::uuid and state = 'pending'
      returning ${REMINDER_COLUMNS}`,
    [id, reason.trim() === '' ? 'cancelled' : reason.trim(), now.toISOString()],
  );
  return rows.length > 0 ? toReminder(rows[0] as ReminderRow) : null;
}

/**
 * Everything due now and still worth firing.
 *
 * The lower bound is the grace window: a reminder the machine slept through by
 * more than `REMINDER_GRACE_MS` is not returned here — `expireOverdueReminders`
 * closes it out instead.
 */
export async function dueReminders(
  pool: Queryable,
  now: Date,
  graceMs: number = REMINDER_GRACE_MS,
): Promise<Reminder[]> {
  const { rows } = await pool.query(
    `select ${REMINDER_COLUMNS} from core.reminders
      where state = 'pending'
        and due_at <= $1::timestamptz
        and due_at > $2::timestamptz
      order by due_at, id
      limit 100`,
    [now.toISOString(), new Date(now.getTime() - graceMs).toISOString()],
  );
  return rows.map((row) => toReminder(row as ReminderRow));
}

/**
 * Close out the ones the machine slept through.
 *
 * docs/architecture.md, principle 3: some things cannot be recovered. A nudge that
 * is a day and a half late is one of them — delivering it would be worse than
 * the silence, so it is marked `expired` and stays visible as such.
 */
export async function expireOverdueReminders(
  pool: Queryable,
  now: Date,
  graceMs: number = REMINDER_GRACE_MS,
): Promise<Reminder[]> {
  const { rows } = await pool.query(
    `update core.reminders
        set state = 'expired'
      where state = 'pending' and due_at <= $1::timestamptz
      returning ${REMINDER_COLUMNS}`,
    [new Date(now.getTime() - graceMs).toISOString()],
  );
  return rows.map((row) => toReminder(row as ReminderRow));
}

/**
 * Mark a reminder fired. Guarded on `pending`, so the second pass over a
 * reminder whose job is already queued writes nothing and returns null — which
 * is what makes the firing loop safe to run twice.
 */
export async function markFired(
  pool: Queryable,
  id: string,
  now: Date = new Date(),
): Promise<Reminder | null> {
  const { rows } = await pool.query(
    `update core.reminders
        set state = 'fired', fired_at = $2::timestamptz
      where id = $1::uuid and state = 'pending'
      returning ${REMINDER_COLUMNS}`,
    [id, now.toISOString()],
  );
  return rows.length > 0 ? toReminder(rows[0] as ReminderRow) : null;
}
