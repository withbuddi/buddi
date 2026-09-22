/**
 * Reading a message for dates, and keeping what was read (`email.dates`).
 *
 * Two callers, one scan:
 *
 *  - **ingest**, in `sources/inbox-poll.ts`, on the body it already has in
 *    memory. That is the cheap half and it is where almost every date is found.
 *  - **the sentinel tick**, for catch-up: messages that landed before this
 *    feature existed, or while it threw. Bounded per tick, oldest first.
 *
 * `messages.dates_scanned_at` is the line between them, stamped even when
 * nothing was found — so a message is read for dates exactly once, and "no
 * dates in it" does not look like "never looked".
 *
 * A message from a sender the owner has an `ignore` policy about is stamped
 * without being read. §7's watchers are not a way around the gate: a sender
 * the owner silenced does not get to put a date in front of them through a
 * different door.
 */
import type { Pool, PoolClient } from 'pg';
import { findDates, type DateHit, type FindDatesOptions } from './dates.js';

type Db = Pool | PoolClient;

/** How many unscanned messages one sentinel tick reads. */
export const DATE_SCAN_BATCH = 200;

/** A message the catch-up sweep is about to read. */
export interface ScannableMessage {
  id: string;
  subject: string;
  bodyText: string | null;
  /** The ordering clock: INTERNALDATE, `fetched_at` as the fallback. */
  at: Date;
  /** True when a live `ignore` policy covers this sender, in this account. */
  ignored: boolean;
}

/**
 * Store what the parser found, and stamp the message as read.
 *
 * One statement per hit and one stamp, all idempotent: `on conflict do update`
 * keeps the better reading if a rescan is ever forced, and the stamp makes the
 * usual case a single write.
 */
export async function recordDates(
  db: Db,
  messageId: string,
  hits: readonly DateHit[],
  now: Date,
): Promise<number> {
  for (const hit of hits) {
    await db.query(
      `insert into email.dates (message_id, on_date, phrase, confidence, found_at)
       values ($1::uuid, $2::date, $3, $4, $5)
       on conflict (message_id, on_date) do update
          set phrase = excluded.phrase,
              confidence = greatest(email.dates.confidence, excluded.confidence)`,
      [messageId, hit.date, hit.phrase, hit.confidence, now],
    );
  }
  await db.query(`update email.messages set dates_scanned_at = $2 where id = $1::uuid`, [
    messageId,
    now,
  ]);
  return hits.length;
}

/** Stamp a message as read for dates without reading it. See the module note. */
export async function skipDates(db: Db, messageId: string, now: Date): Promise<void> {
  await db.query(`update email.messages set dates_scanned_at = $2 where id = $1::uuid`, [
    messageId,
    now,
  ]);
}

/**
 * Read one message's text for dates and keep the result.
 *
 * `at` is the message's own instant, not the clock: a mail that arrived on
 * Friday and is scanned on Monday still means the Friday sender's Thursday.
 */
export async function scanMessageDates(
  db: Db,
  message: { id: string; bodyText: string | null; subject?: string },
  opts: FindDatesOptions,
  now: Date,
): Promise<DateHit[]> {
  // The subject carries the date as often as the body ("Invoice due 22/09"),
  // and it is the one part retention never purges.
  const text = [message.subject ?? '', message.bodyText ?? ''].filter((p) => p.trim() !== '').join('\n');
  const hits = findDates(text, opts);
  await recordDates(db, message.id, hits, now);
  return hits;
}

/**
 * Messages nothing has read for dates yet, oldest fetched first, bounded.
 *
 * Inbound only: a date the owner wrote himself is his own diary, and reminding
 * somebody of what they just said is the kind of help nobody asked for. The
 * `ignored` flag is computed here, in the same query, from the live sender and
 * domain policies of that message's own account — one query instead of one per
 * message, and the same normalisation the gate uses.
 */
export async function unscannedMessages(
  db: Db,
  limit = DATE_SCAN_BATCH,
): Promise<ScannableMessage[]> {
  const { rows } = await db.query(
    `select m.id, m.subject, m.body_text,
            coalesce(m.internal_date, m.fetched_at) as at,
            exists (
              select 1 from email.policies p
               where p.revoked_at is null
                 and p.proposed = false
                 and p.action = 'ignore'
                 and (p.account_id is null or p.account_id = m.account_id)
                 and (
                   (p.scope = 'sender' and p.matcher = email.address_of(m.from_addr))
                   or (p.scope = 'domain'
                       and p.matcher = split_part(email.address_of(m.from_addr), '@', 2))
                 )
            ) as ignored
       from email.messages m
      where m.dates_scanned_at is null
        and m.direction = 'in'
      -- fetched_at, not coalesce(internal_date, fetched_at): it is the
      -- expression the partial index is on (migration 009), so the sweep walks
      -- the index instead of sorting every unscanned message in the mailbox.
      -- The two orders differ only for backfilled rows, and a sweep does not
      -- care which of two old messages it reads first.
      order by m.fetched_at asc, m.id asc
      limit $1`,
    [limit],
  );
  return rows.map((row: Record<string, any>) => ({
    id: String(row.id),
    subject: row.subject ?? '',
    bodyText: row.body_text ?? null,
    at: row.at instanceof Date ? row.at : new Date(String(row.at)),
    ignored: row.ignored === true,
  }));
}

/**
 * Stored hits in the window, above a confidence, with their message and thread.
 *
 * `from` and `to` are days in the owner's zone, as `YYYY-MM-DD`. Muted
 * conversations are left out — a muted thread is a decision, and a date in it
 * is not an argument against the decision — and so are messages whose sender
 * has since been silenced by a policy: the sweep skipped them at scan time,
 * but a policy applied *after* the scan must silence what is already stored.
 */
export async function statedDatesBetween(
  db: Db,
  from: string,
  to: string,
  minConfidence: number,
): Promise<
  Array<{
    messageId: string;
    threadId: string | null;
    subject: string;
    from: string;
    date: string;
    phrase: string;
    confidence: number;
  }>
> {
  const { rows } = await db.query(
    `select d.message_id, m.thread_id, m.subject, m.from_addr,
            to_char(d.on_date, 'YYYY-MM-DD') as on_date, d.phrase, d.confidence
       from email.dates d
       join email.messages m on m.id = d.message_id
       left join email.threads t on t.id = m.thread_id
      where d.on_date >= $1::date and d.on_date <= $2::date
        and d.confidence >= $3
        and m.direction = 'in'
        and coalesce(t.state, 'waiting-on-me') <> 'muted'
        and not exists (
          select 1 from email.policies p
           where p.revoked_at is null
             and p.proposed = false
             and p.action = 'ignore'
             and (p.account_id is null or p.account_id = m.account_id)
             and (
               (p.scope = 'sender' and p.matcher = email.address_of(m.from_addr))
               or (p.scope = 'domain'
                   and p.matcher = split_part(email.address_of(m.from_addr), '@', 2))
             )
        )
      order by d.on_date asc, d.confidence desc, d.message_id asc`,
    [from, to, minConfidence],
  );
  return rows.map((row: Record<string, any>) => ({
    messageId: String(row.message_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    subject: row.subject ?? '',
    from: row.from_addr ?? '',
    date: String(row.on_date),
    phrase: row.phrase ?? '',
    confidence: Number(row.confidence),
  }));
}

/**
 * Which of these (thread, day) pairs already have a reminder.
 *
 * `core.reminders` is core's table and this is a read of it: a reminder is the
 * thing §7 says makes a stated date not worth mentioning, and the plugin has
 * to be able to see one. A pending reminder whose `context` names this thread,
 * due on that day in the owner's zone, is the owner already knowing.
 *
 * Returns a set of `${threadId}|${date}` keys. A reminder that names no thread
 * is no answer to this question and is not matched: two different mails can
 * state the same Tuesday, and a reminder about one of them is not the owner
 * knowing about the other.
 */
export async function remindersFor(
  db: Db,
  threadIds: readonly string[],
  days: readonly string[],
  timezone: string,
): Promise<Set<string>> {
  const covered = new Set<string>();
  if (threadIds.length === 0 || days.length === 0) return covered;
  const { rows } = await db.query(
    `select coalesce(r.context->>'threadId', r.context->>'thread_id') as thread_id,
            to_char((r.due_at at time zone $3)::date, 'YYYY-MM-DD') as due_day
       from core.reminders r
      where r.state = 'pending'
        and coalesce(r.context->>'threadId', r.context->>'thread_id') = any($1::text[])
        and (r.due_at at time zone $3)::date = any($2::date[])`,
    [threadIds, days, timezone],
  );
  for (const row of rows) covered.add(`${String(row.thread_id)}|${String(row.due_day)}`);
  return covered;
}
