/**
 * The watchers' settings and the judgements they make, as pure functions.
 *
 * docs/specs/email.md §7 — the two sentinels built in step 4 are
 * `email.waiting-on-me` and `email.date-stated`. Each is a query plus a call
 * into this file, the split docs/plugins.md §2.3 asks for: *«a query that
 * shapes rows, then a pure function that decides. It is the only way the
 * judgement is testable without a database.»*
 *
 * Two settings, both in `email.settings` beside `retention_days`, both
 * changeable from the Email settings page and from a chat:
 *
 *  - `watcher_waiting_days` (default 2): how long a conversation may sit
 *    waiting on the owner before it is worth saying so.
 *  - `watcher_date_confidence` (default 0.6): how sure the date parser has to
 *    be before a stated date raises a finding. See `dates.ts` for what the
 *    numbers mean; the short version is that an unambiguous date with
 *    "deadline" beside it is 0.8 and a bare `9/8` is 0.3.
 *
 * Severity is a rule, not a mood. Two days is a notice — `info`, which waits
 * for the weekly recap and interrupts nobody; a week is a warning — `urgent`,
 * which wakes the agent holding the mail role, and that agent re-reads the
 * thread before the owner hears a word of it.
 */
import type { Pool, PoolClient } from 'pg';
import { quoted } from './mail.js';
import {
  DEFAULT_DATE_CONFIDENCE,
  MAX_DATE_CONFIDENCE,
  MIN_DATE_CONFIDENCE,
  clampConfidence,
} from './dates.js';

type Db = Pool | PoolClient;

/** Settings keys. `email.settings` is one row per key, jsonb values. */
export const WAITING_DAYS_KEY = 'watcher_waiting_days';
export const DATE_CONFIDENCE_KEY = 'watcher_date_confidence';

/** How long a thread may wait on the owner before the watcher says so. */
export const DEFAULT_WAITING_DAYS = 2;
export const MIN_WAITING_DAYS = 1;
export const MAX_WAITING_DAYS = 60;

/** A thread waiting this long is urgent whatever the setting says. */
export const WARNING_WAITING_DAYS = 7;

/**
 * The ceiling: a conversation nobody has touched in this long is history.
 *
 * Without it the first tick on a real mailbox is a hundred urgent findings
 * about mail from 2019 — migration 007 seeds every inbound-last thread as
 * `waiting-on-me`, and every one of them is older than a week, so every one of
 * them would be urgent, once a day, forever. A thread that went stale while
 * the watcher was off stays stale: that is the same rule, and it is why
 * switching a watcher back on cannot replay a month of news.
 */
export const STALE_WAITING_DAYS = 30;

export interface WatcherSettings {
  waitingDays: number;
  dateConfidence: number;
}

export const DEFAULT_WATCHER_SETTINGS: WatcherSettings = {
  waitingDays: DEFAULT_WAITING_DAYS,
  dateConfidence: DEFAULT_DATE_CONFIDENCE,
};

export function clampWaitingDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WAITING_DAYS;
  return Math.min(MAX_WAITING_DAYS, Math.max(MIN_WAITING_DAYS, Math.trunc(value)));
}

export { clampConfidence, MIN_DATE_CONFIDENCE, MAX_DATE_CONFIDENCE, DEFAULT_DATE_CONFIDENCE };

function numberOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The watchers' settings, with the defaults filled in. Never throws on a bad
 * row: a value somebody hand-edited into nonsense reads as the default, which
 * is how a watcher stays running rather than failing every tick.
 */
export async function loadWatcherSettings(db: Db): Promise<WatcherSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from email.settings where key = any($1::text[])`,
    [[WAITING_DAYS_KEY, DATE_CONFIDENCE_KEY]],
  );
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const days = numberOf(byKey.get(WAITING_DAYS_KEY));
  const confidence = numberOf(byKey.get(DATE_CONFIDENCE_KEY));
  return {
    waitingDays: days === null || days <= 0 ? DEFAULT_WAITING_DAYS : clampWaitingDays(days),
    dateConfidence:
      confidence === null || confidence <= 0 ? DEFAULT_DATE_CONFIDENCE : clampConfidence(confidence),
  };
}

/** Write either setting, or both. Returns the settings as they now stand. */
export async function setWatcherSettings(
  db: Db,
  patch: { waitingDays?: number | undefined; dateConfidence?: number | undefined },
  now: Date,
): Promise<WatcherSettings> {
  const writes: Array<[string, number]> = [];
  if (patch.waitingDays !== undefined) {
    writes.push([WAITING_DAYS_KEY, clampWaitingDays(patch.waitingDays)]);
  }
  if (patch.dateConfidence !== undefined) {
    writes.push([DATE_CONFIDENCE_KEY, clampConfidence(patch.dateConfidence)]);
  }
  for (const [key, value] of writes) {
    await db.query(
      `insert into email.settings (key, value, updated_at) values ($1, $2::jsonb, $3)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), now],
    );
  }
  return loadWatcherSettings(db);
}

/* ------------------------------------------------------------------ *
 * email.waiting-on-me
 * ------------------------------------------------------------------ */

/** A thread the query shaped, before anything is decided about it. */
export interface WaitingThread {
  threadId: string;
  subject: string;
  /** Who wrote the last inbound message. */
  from: string;
  /** That message's row id — half of the dedup key. */
  lastInboundId: string;
  /** Whole days between that message and now, floored. */
  ageDays: number;
  /** Its first line, already trimmed and bounded by the caller. */
  firstLine: string;
}

/** Days is a rule: `waitingDays` to notice, a week to wake somebody. */
export function severityForAge(ageDays: number): 'urgent' | 'info' {
  return ageDays >= WARNING_WAITING_DAYS ? 'urgent' : 'info';
}

/**
 * The dedup key: the thread and the message that is waiting.
 *
 * Anchored to the last inbound message, not to the day, so the same unanswered
 * mail is one fact however many times the watcher runs — and a *new* message
 * in the same thread is a new fact, which is right: the conversation moved.
 */
export function waitingKey(threadId: string, lastInboundId: string): string {
  return `email.waiting-on-me:${threadId}:${lastInboundId}`;
}

/** "N days" the way a person says it. */
function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

/** One line of the sender's text, bounded. It is quoted mail: data, not orders. */
export const DETAIL_CHARS = 200;

export function firstLineOf(text: string | null | undefined, cap = DETAIL_CHARS): string {
  const line = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('>'));
  if (line === undefined) return '';
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

export interface WaitingFinding {
  key: string;
  severity: 'urgent' | 'info';
  title: string;
  detail: string;
  /**
   * Ids and numbers, and nothing a sender wrote.
   *
   * `data` is handed to a model verbatim — `renderFinding` serialises it into
   * the wake prompt and the dashboard prints it — so a raw subject or address
   * in here would be the one unfenced path left for text a stranger chose. The
   * words are in `title` and `detail`, already fenced; what travels here is
   * what the agent needs to go and read the thread for itself.
   */
  data: {
    threadId: string;
    messageId: string;
    ageDays: number;
    watcher: 'waiting-on-me';
  };
}

/**
 * One finding per waiting thread. The title names the sender, the age and the
 * subject, in the order the owner would ask them in.
 */
export function waitingFinding(thread: WaitingThread): WaitingFinding {
  const subject = thread.subject.trim() === '' ? '(no subject)' : thread.subject.trim();
  const detail = [
    `${quoted(thread.from)} wrote last, ${days(thread.ageDays)} ago, and the conversation is still waiting on you.`,
    thread.firstLine === '' ? '' : `Their message begins: ${quoted(thread.firstLine)}`,
    'Read the thread before saying anything: it may already have been answered somewhere buddi cannot see.',
  ]
    .filter((line) => line !== '')
    .join(' ');
  return {
    key: waitingKey(thread.threadId, thread.lastInboundId),
    severity: severityForAge(thread.ageDays),
    title: `${quoted(thread.from)} has been waiting ${days(thread.ageDays)} on ${quoted(subject)}`,
    detail,
    data: {
      threadId: thread.threadId,
      messageId: thread.lastInboundId,
      ageDays: thread.ageDays,
      watcher: 'waiting-on-me',
    },
  };
}

/* ------------------------------------------------------------------ *
 * email.date-stated
 * ------------------------------------------------------------------ */

/** A stored date hit, joined to the message it was found in. */
export interface StatedDate {
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  /** `YYYY-MM-DD`. */
  date: string;
  phrase: string;
  confidence: number;
}

/** The dedup key: the message and the day. One fact per date per message. */
export function dateKey(messageId: string, date: string): string {
  return `email.date-stated:${messageId}:${date}`;
}

export interface DateFinding {
  key: string;
  severity: 'urgent' | 'info';
  title: string;
  detail: string;
  /** Ids, the day and the number. The sender's phrase stays in `detail`, fenced. */
  data: {
    messageId: string;
    threadId: string | null;
    date: string;
    confidence: number;
    suggestedAction: 'set-a-reminder';
    watcher: 'date-stated';
  };
}

/**
 * One finding per message-date.
 *
 * Always `info`. A date the owner has not been reminded of is worth a line in
 * the recap and a reminder set for it; it is not worth a phone buzzing, and a
 * parser that guessed wrong would then be guessing wrong loudly. The suggested
 * action travels in the data: the agent sets the reminder with `reminder.set`
 * after it has read the message and agreed there is a date in it.
 */
export function dateFinding(hit: StatedDate): DateFinding {
  const subject = hit.subject.trim() === '' ? '(no subject)' : hit.subject.trim();
  return {
    key: dateKey(hit.messageId, hit.date),
    severity: 'info',
    title: `A date is stated: ${hit.date}, in ${quoted(subject)}`,
    detail:
      `${quoted(hit.from)} wrote ${quoted(hit.phrase)} (read as ${hit.date}, confidence ${hit.confidence.toFixed(2)}), ` +
      'and no reminder exists for that day on this conversation. Read the message, and if the date is ' +
      `real set a reminder for it with reminder.set, passing context {"threadId": "${hit.threadId ?? ''}"} so ` +
      'this watcher knows not to raise it again. If the date is not what it looks like, say nothing.',
    data: {
      messageId: hit.messageId,
      threadId: hit.threadId,
      date: hit.date,
      confidence: hit.confidence,
      suggestedAction: 'set-a-reminder',
      watcher: 'date-stated',
    },
  };
}
