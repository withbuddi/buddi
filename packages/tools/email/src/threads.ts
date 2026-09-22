/**
 * The thread: the unit mail is actually read in.
 *
 * docs/email.md §2 — *«The thread is the unit, not the message. Who wrote last
 * is state.»* This file is that state and the one rule that maintains it, and
 * it is deliberately small: a thread is not a judgement, it is a fact about
 * what has arrived and what has been sent.
 *
 * ## The state machine, in four lines
 *
 *  - a message the owner **sent** (`direction: out`, which today means a
 *    message from the Sent folder) leaves the thread `waiting-on-them`;
 *  - a message that **arrived** leaves it `waiting-on-me`;
 *  - **`muted` is sticky.** The owner muting a conversation is a decision, and
 *    new mail is not an argument against it. Nothing here ever lifts it;
 *    `email.mute_thread` sets it and only the owner takes it back.
 *  - `closed` says nothing more is expected. Only the backfill sets it today,
 *    and new mail moves the thread out of it, because a conversation somebody
 *    answered is not closed however sure we were.
 *
 * Nothing in this file looks at a message's *body*. A thread's state is who
 * wrote last, and deriving it from anything a sender wrote would put the
 * sender in charge of whether the owner is waiting.
 */
import type { Pool, PoolClient } from 'pg';
import { normalizeAddresses } from './mail.js';
import type { MessageDirection } from './rows.js';

type Db = Pool | PoolClient;

export const THREAD_STATES = ['waiting-on-me', 'waiting-on-them', 'closed', 'muted'] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export interface ThreadRecord {
  id: string;
  accountId: string;
  threadKey: string;
  subject: string;
  participants: string[];
  firstAt: string | null;
  lastAt: string | null;
  state: ThreadState;
  policyId: string | null;
  messageCount: number;
  lastDirection: MessageDirection;
}

export const THREAD_COLUMNS =
  'id, account_id, thread_key, subject, participants, first_at, last_at, state, policy_id, ' +
  'message_count, last_direction';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toThread(row: Record<string, any>): ThreadRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    threadKey: row.thread_key,
    subject: row.subject ?? '',
    participants: Array.isArray(row.participants)
      ? row.participants.filter((p: unknown): p is string => typeof p === 'string')
      : [],
    firstAt: iso(row.first_at),
    lastAt: iso(row.last_at),
    state: (THREAD_STATES as readonly string[]).includes(row.state)
      ? (row.state as ThreadState)
      : 'waiting-on-me',
    policyId: row.policy_id === null || row.policy_id === undefined ? null : String(row.policy_id),
    messageCount: Number(row.message_count ?? 0),
    lastDirection: row.last_direction === 'out' ? 'out' : 'in',
  };
}

/**
 * The key a message threads under.
 *
 * `threadKeyFor` has already taken the root of the References chain; what is
 * left is the message that carries no identifier at all, which is a
 * conversation of one and is keyed by its own row. "No thread" is then never a
 * state a caller has to handle, and two such messages never collapse into one
 * conversation because they both had nothing.
 */
export function threadKeyOf(threadKey: string | null, messageRowId: string): string {
  const key = threadKey?.trim();
  return key ? key : `message:${messageRowId}`;
}

export interface JoinThreadInput {
  accountId: string;
  /** The message's own thread key, as ingest derived it. May be null. */
  threadKey: string | null;
  messageRowId: string;
  subject: string;
  /** Everyone on this message: From, To and Cc, in any form. */
  participants: readonly string[];
  /** When it was sent or received. */
  at: Date | string | null;
  direction: MessageDirection;
}

/**
 * Put one message into its thread, creating the thread if this is the first of
 * it, and return the thread as it now stands.
 *
 * One statement, so the read and the write cannot race each other: two polls
 * landing the same conversation at once produce one thread, and `message_count`
 * counts messages rather than attempts.
 */
export async function joinThread(db: Db, input: JoinThreadInput): Promise<ThreadRecord> {
  const key = threadKeyOf(input.threadKey, input.messageRowId);
  const participants = normalizeAddresses(input.participants);
  const at = input.at === null ? null : input.at instanceof Date ? input.at : new Date(input.at);
  const state: ThreadState = input.direction === 'out' ? 'waiting-on-them' : 'waiting-on-me';

  const { rows } = await db.query(
    `insert into email.threads
       (account_id, thread_key, subject, participants, first_at, last_at, message_count,
        last_direction, state)
     values ($1, $2, $3, $4::jsonb, $5, $5, 1, $6, $7)
     on conflict (account_id, thread_key) do update
        set subject = case when email.threads.subject = '' then excluded.subject
                           else email.threads.subject end,
            -- The union: who is in a conversation only ever grows.
            participants = email.merge_participants(
              email.threads.participants, excluded.participants
            ),
            first_at = least(
              coalesce(email.threads.first_at, excluded.first_at),
              coalesce(excluded.first_at, email.threads.first_at)
            ),
            last_at = greatest(
              coalesce(email.threads.last_at, excluded.last_at),
              coalesce(excluded.last_at, email.threads.last_at)
            ),
            message_count = email.threads.message_count + 1,
            -- Who wrote last, by the clock: a message fetched late but dated
            -- before the newest one does not change whose turn it is.
            last_direction = case
              when excluded.last_at is null then email.threads.last_direction
              when email.threads.last_at is null then excluded.last_direction
              when excluded.last_at >= email.threads.last_at then excluded.last_direction
              else email.threads.last_direction
            end,
            state = case
              -- The owner's decision. New mail is not an argument against it.
              when email.threads.state = 'muted' then 'muted'
              when excluded.last_at is not null
               and email.threads.last_at is not null
               and excluded.last_at < email.threads.last_at then email.threads.state
              else excluded.state
            end
     returning ${THREAD_COLUMNS}`,
    [input.accountId, key, input.subject ?? '', JSON.stringify(participants), at, input.direction, state],
  );
  const row = rows[0];
  if (!row) throw new Error('joinThread: upsert returned no row');
  const thread = toThread(row);

  await db.query(`update email.messages set thread_id = $2 where id = $1`, [
    input.messageRowId,
    thread.id,
  ]);
  return thread;
}

export async function findThread(db: Db, id: string): Promise<ThreadRecord | null> {
  const { rows } = await db.query(
    `select ${THREAD_COLUMNS} from email.threads where id = $1::uuid`,
    [id],
  );
  return rows[0] ? toThread(rows[0]) : null;
}

/** The thread a message belongs to, or null when it has none yet. */
export async function threadOfMessage(db: Db, messageId: string): Promise<ThreadRecord | null> {
  const { rows } = await db.query(
    `select t.id, t.account_id, t.thread_key, t.subject, t.participants, t.first_at, t.last_at,
            t.state, t.policy_id, t.message_count, t.last_direction
       from email.threads t
       join email.messages m on m.thread_id = t.id
      where m.id = $1::uuid`,
    [messageId],
  );
  return rows[0] ? toThread(rows[0]) : null;
}

/** One message of a thread, as a thread view shows it. */
export interface ThreadMessage {
  id: string;
  direction: MessageDirection;
  from: string;
  to: string[];
  subject: string;
  date: string | null;
  snippet: string;
  bodyText: string | null;
}

/**
 * The messages of one thread, oldest first, at most `limit` of them — the
 * newest ones, because a conversation is read from where it got to.
 */
export async function threadMessages(
  db: Db,
  threadId: string,
  limit: number,
): Promise<ThreadMessage[]> {
  const { rows } = await db.query(
    `select id, direction, from_addr, to_addrs, subject, date, snippet, body_text
       from (
         select id, direction, from_addr, to_addrs, subject, date, snippet, body_text,
                coalesce(date, fetched_at) as at, uid
           from email.messages
          where thread_id = $1::uuid
          order by at desc, uid desc
          limit $2
       ) newest
      order by at asc, uid asc`,
    [threadId, limit],
  );
  return rows.map((row: Record<string, any>) => ({
    id: String(row.id),
    direction: row.direction === 'out' ? 'out' : 'in',
    from: row.from_addr,
    to: Array.isArray(row.to_addrs) ? row.to_addrs : [],
    subject: row.subject ?? '',
    date: iso(row.date),
    snippet: row.snippet ?? '',
    bodyText: row.body_text ?? null,
  }));
}

/** Set a thread's state. Returns the thread, or null when there is no such one. */
export async function setThreadState(
  db: Db,
  threadId: string,
  state: ThreadState,
): Promise<ThreadRecord | null> {
  const { rows } = await db.query(
    `update email.threads set state = $2 where id = $1::uuid returning ${THREAD_COLUMNS}`,
    [threadId, state],
  );
  return rows[0] ? toThread(rows[0]) : null;
}

export interface ListThreadsFilter {
  accountIds: readonly string[];
  state?: ThreadState | undefined;
  participant?: string | undefined;
  limit: number;
}

/** Threads, most recently moved first. */
export async function listThreadRows(
  db: Db,
  filter: ListThreadsFilter,
): Promise<ThreadRecord[]> {
  const params: unknown[] = [filter.accountIds];
  const where = ['account_id = any($1::uuid[])'];
  if (filter.state) {
    params.push(filter.state);
    where.push(`state = $${params.length}`);
  }
  if (filter.participant) {
    params.push(JSON.stringify([filter.participant]));
    where.push(`participants @> $${params.length}::jsonb`);
  }
  params.push(filter.limit);
  const { rows } = await db.query(
    `select ${THREAD_COLUMNS} from email.threads
      where ${where.join(' and ')}
      order by last_at desc nulls last, id desc
      limit $${params.length}`,
    params,
  );
  return rows.map(toThread);
}
