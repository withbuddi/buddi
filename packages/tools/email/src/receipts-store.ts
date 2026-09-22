/**
 * Reading a message for receipt vocabulary, and keeping what was read.
 *
 * The same shape as `dates-store.ts`, for the same reasons: the classifier is
 * pure (`phrases.ts`), the reading is stored once (`email.receipts`), and
 * `messages.receipts_scanned_at` is the line that makes "not a receipt"
 * different from "never looked".
 *
 * One departure from dates, and it is deliberate: there is no ingest half. A
 * receipt is worth a finding for a fortnight and nothing about it is urgent, so
 * the hourly sweep is early enough, and the poll path stays as narrow as it is.
 *
 * A message from a sender the owner has a live `ignore` policy about is not
 * read, and — a change from how dates does it — is **not stamped either**. A
 * stamp is permanent, and an `ignore` policy is not: the owner revokes rules
 * from the Learned list, and a stamped message would stay unread for ever
 * afterwards. Leaving it unstamped costs nothing, because the sweep's own
 * query excludes it, so it never takes a slot in the batch; revoke the policy
 * and the next tick reads it. A policy that arrives *after* a scan still
 * silences what is already stored, in `receiptsSince`.
 */
import type { Pool, PoolClient } from 'pg';
import { classifyReceipt, firstLines, type ReceiptReading } from './phrases.js';

type Db = Pool | PoolClient;

/** How many unscanned messages one sentinel tick reads. */
export const RECEIPT_SCAN_BATCH = 200;

/** How many out-of-window messages one tick stamps without reading. */
export const RECEIPT_STAMP_BATCH = 2000;

/** How many lines of the body the classifier is shown. §7's "the first lines". */
export const RECEIPT_BODY_LINES = 12;

/** A message the catch-up sweep is about to read. */
export interface ScannableReceipt {
  id: string;
  subject: string;
  from: string;
  bodyText: string | null;
}

/** The live-ignore predicate the gate uses, as a fragment over an alias. */
export function ignoredSql(alias: string): string {
  return `exists (
    select 1 from email.policies p
     where p.revoked_at is null
       and p.proposed = false
       and p.action = 'ignore'
       and (p.account_id is null or p.account_id = ${alias}.account_id)
       and (
         (p.scope = 'sender' and p.matcher = email.address_of(${alias}.from_addr))
         or (p.scope = 'domain'
             and p.matcher = split_part(email.address_of(${alias}.from_addr), '@', 2))
       )
  )`;
}

/**
 * Messages nothing has read for receipts yet, oldest first, bounded twice.
 *
 * `since` is the second bound and it is the one that matters: the watcher only
 * ever reports mail from the last fortnight, so reading anything older is work
 * for a finding that cannot be raised. Without it a mailbox that takes in more
 * than `RECEIPT_SCAN_BATCH` messages an hour never reaches today's mail at all
 * — the sweep walks the backlog oldest-first for ever and the watcher is
 * silent about exactly the mail it exists for. What falls out of the window
 * unread is stamped in bulk by `stampOldReceipts`.
 *
 * Senders under a live `ignore` are excluded here rather than stamped: see the
 * module note.
 */
export async function unscannedReceipts(
  db: Db,
  since: Date,
  limit = RECEIPT_SCAN_BATCH,
): Promise<ScannableReceipt[]> {
  const { rows } = await db.query(
    `select m.id, m.subject, m.from_addr, m.body_text
       from email.messages m
      where m.receipts_scanned_at is null
        and m.direction = 'in'
        and coalesce(m.internal_date, m.fetched_at) >= $1::timestamptz
        and not ${ignoredSql('m')}
      order by m.fetched_at asc, m.id asc
      limit $2`,
    [since, limit],
  );
  return rows.map((row: Record<string, any>) => ({
    id: String(row.id),
    subject: row.subject ?? '',
    from: row.from_addr ?? '',
    bodyText: row.body_text ?? null,
  }));
}

/**
 * Stamp, in one statement, the mail that fell out of the window unread.
 *
 * This is what keeps the sweep's backlog finite. It is bounded per tick so a
 * mailbox with a decade of history does not lock the table for a minute.
 *
 * It carries **the same `ignore` predicate the scan does**, and that is the
 * point of it being here rather than left to the caller's choice of cutoff. A
 * stamp is permanent; an `ignore` rule is one tap from being revoked. A bulk
 * stamp blind to the policy would mean that whether a silenced sender's mail
 * could ever be read again depended on whether this statement happened to run
 * before the owner changed his mind — and it runs every hour. With the
 * predicate, a silenced message is simply not stamped while the rule lives;
 * revoke the rule and the next tick either reads it, if it is still inside the
 * window, or stamps it here like everything else.
 *
 * The cost, stated plainly: mail from a sender who is silenced for ever stays
 * unstamped for ever, and sits in the partial index. That is the same state it
 * is in inside the window today, and it buys the owner the right to change his
 * mind about a rule without that having been decided for him by a sweep.
 */
export async function stampOldReceipts(
  db: Db,
  before: Date,
  now: Date,
  limit = RECEIPT_STAMP_BATCH,
): Promise<number> {
  const { rowCount } = await db.query(
    `update email.messages set receipts_scanned_at = $2
      where id in (
        select m.id from email.messages m
         where m.receipts_scanned_at is null
           and m.direction = 'in'
           and coalesce(m.internal_date, m.fetched_at) < $1::timestamptz
           and not ${ignoredSql('m')}
         order by m.fetched_at asc, m.id asc
         limit $3
      )`,
    [before, now, limit],
  );
  return rowCount ?? 0;
}

/**
 * Store one reading **and** stamp the message, in a single statement.
 *
 * The two used to be two statements, and the order made the failure silent: a
 * reading that threw on insert — an amount out of `numeric(14,2)`, a lost
 * connection — left the message stamped as read with nothing stored, which is
 * the one state from which the fact can never be recovered. A data-modifying
 * CTE makes them one statement, so either both happen or neither does and the
 * message is read again next tick.
 *
 * Idempotent: a forced rescan keeps the better confidence rather than adding a
 * second row, exactly as `recordDates` does.
 */
export async function recordReceipt(
  db: Db,
  messageId: string,
  reading: ReceiptReading | null,
  now: Date,
): Promise<void> {
  if (reading === null) {
    await db.query(`update email.messages set receipts_scanned_at = $2 where id = $1::uuid`, [
      messageId,
      now,
    ]);
    return;
  }
  await db.query(
    `with stored as (
       insert into email.receipts (message_id, confidence, phrase, amount, currency, found_at)
       values ($1::uuid, $2, $3, $4, $5, $6)
       on conflict (message_id) do update
          set confidence = greatest(email.receipts.confidence, excluded.confidence),
              phrase = excluded.phrase,
              amount = excluded.amount,
              currency = excluded.currency
       returning message_id
     )
     update email.messages set receipts_scanned_at = $6
      where id = (select message_id from stored)`,
    [
      messageId,
      reading.confidence,
      reading.phrase,
      reading.amount === null ? null : reading.amount.value,
      reading.amount === null ? null : reading.amount.currency,
      now,
    ],
  );
}

/** Read one message and keep the result. The classifier's only caller. */
export async function scanMessageReceipt(
  db: Db,
  message: { id: string; subject: string; from: string; bodyText: string | null },
  now: Date,
): Promise<ReceiptReading | null> {
  const reading = classifyReceipt({
    subject: message.subject,
    from: message.from,
    body: firstLines(message.bodyText, RECEIPT_BODY_LINES),
  });
  await recordReceipt(db, message.id, reading, now);
  return reading;
}

/** A stored reading, joined to the message it was found in. */
export interface StoredReceipt {
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  confidence: number;
  phrase: string;
  amount: number | null;
  currency: string | null;
}

/**
 * Stored readings for messages that arrived since `since`, above a confidence.
 *
 * Muted conversations are left out — a muted thread is a decision — and so are
 * senders an `ignore` policy has covered since the scan.
 */
export async function receiptsSince(
  db: Db,
  since: Date,
  minConfidence: number,
): Promise<StoredReceipt[]> {
  const { rows } = await db.query(
    `select r.message_id, m.thread_id, m.subject, m.from_addr,
            r.confidence, r.phrase, r.amount, r.currency
       from email.receipts r
       join email.messages m on m.id = r.message_id
       left join email.threads t on t.id = m.thread_id
      where m.direction = 'in'
        and coalesce(m.internal_date, m.fetched_at) >= $1::timestamptz
        and r.confidence >= $2
        and coalesce(t.state, 'waiting-on-me') <> 'muted'
        and not ${ignoredSql('m')}
      order by coalesce(m.internal_date, m.fetched_at) desc, r.message_id asc`,
    [since, minConfidence],
  );
  return rows.map((row: Record<string, any>) => ({
    messageId: String(row.message_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    subject: row.subject ?? '',
    from: row.from_addr ?? '',
    confidence: Number(row.confidence),
    phrase: row.phrase ?? '',
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: row.currency ?? null,
  }));
}
