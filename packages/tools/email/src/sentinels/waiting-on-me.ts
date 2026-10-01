/**
 * `email.waiting-on-me` — a conversation has been waiting on the owner.
 *
 * docs/email.md §7: a conversation that **needs the owner** (`needs-you.ts`,
 * the one rule the Mail page, the widget and the tools share) and has done for
 * more than N days (default 2). The rule is: inbound last, not muted, not
 * under an ignore rule, not a no-reply or bulk sender, under thirty days old,
 * and either somebody the owner has written to before from this mailbox or a
 * message triage judged to need a reply. Age is measured from INTERNALDATE,
 * never the sender's `Date` header — a forged one would otherwise make
 * anything look a fortnight old.
 *
 * One finding per thread per cycle, keyed to the thread *and* the message that
 * is waiting: a reply arriving means a new key, and core resolves the old one.
 *
 * Two bounds, and they are the difference between a watcher and a nag. The
 * rule only counts the last thirty days — a conversation nobody has touched
 * in a month is history, not an alarm — and the watcher reports the *newest*
 * waiting threads first, so the raise cap truncates the least urgent rows
 * rather than the most recent ones. Every qualifying thread is still returned
 * as a key, capped by nothing, so core does not mistake one it did not hear
 * about for one that was answered.
 */
import type { DbArea, Finding, Sentinel, SentinelContext, SentinelReport } from '@buddi/core/plugin';
import { attentionJoin, needsYouPrefilter } from '../needs-you.js';
import {
  firstLineOf,
  loadWatcherSettings,
  waitingFinding,
  waitingKey,
  type WaitingThread,
} from '../watchers.js';

/** Twice a day. Waiting is measured in days; six-hourly would say the same. */
export const EVERY_12H = 12 * 60 * 60;

/** At most this many findings in one tick. A backlog is a report, not an alarm. */
export const MAX_WAITING_FINDINGS = 20;

/** Who speaks about mail: whoever holds `mail`, else `triage`, else nobody. */
export function mailAgent(ctx: SentinelContext): string | undefined {
  return ctx.buddi!.owner.agentForRole('mail') ?? ctx.buddi!.owner.agentForRole('triage');
}

/**
 * The query: threads that need the owner, with the last inbound message and
 * its age.
 *
 * One statement over the rule's function; the severity and the words are
 * `watchers.ts`'s, over the rows it returns.
 *
 * Two statements read this one source, because there are two questions.
 * *What is still true* has no cap — core resolves every open finding a run did
 * not name, so a key left out of the answer would read as answered and come
 * back as news on the next tick; it is bounded by the thirty-day ceiling and
 * returns two ids per row. *What the owner hears* is capped at twenty, newest
 * first.
 */
const WAITING_SOURCE = `
  with waiting as (
    select t.id as thread_id, t.subject as thread_subject,
           m.id as message_id, m.from_addr, m.subject, m.body_text, m.snippet, att.inbound_at as at, t.account_id,
           floor(extract(epoch from ($1::timestamptz - att.inbound_at)) / 86400.0)::int as age_days
      from email.threads t
      -- Enabled mailboxes only, which is the scope every read tool has
      -- (listAccounts defaults to it). A mailbox the owner switched off keeps
      -- its mail and its cursor and is not walked; a watcher that nagged about
      -- its threads -- or a goal that counted them -- would be speaking about
      -- mail nothing else here will show him.
      join email.accounts a on a.id = t.account_id and a.enabled
      ${attentionJoin('t', '$1')}
      join email.messages m on m.id = att.inbound_id
     where ${needsYouPrefilter('t', '$1')}
       -- The one rule (needs-you.ts): inbound last, not muted, not ignored,
       -- not a no-reply or bulk sender, under thirty days old, and either
       -- somebody the owner has written to from this mailbox or a message
       -- triage judged to need a reply.
       and att.needs_you
       -- ...and waiting longer than the owner's setting. Zero for the count
       -- the widget shows: what needs him now, not what he is nagged about.
       and att.inbound_at <= $1::timestamptz - make_interval(days => $2::int)
  )`;

/** Every key that is still true. No cap: see `WAITING_SOURCE`. */
const WAITING_KEYS_SQL = `${WAITING_SOURCE} select thread_id, message_id from waiting`;

/**
 * How many conversations are waiting, by the same rule and age.
 *
 * `email.waiting_on_me` is this number and nothing else, which is the point:
 * a goal to get the pile down must count what the watcher nags about, or the
 * owner would be working against one number and hearing about another.
 */
export const WAITING_COUNT_SQL = `${WAITING_SOURCE} select count(*)::int as n from waiting`;

/** The same count in some mailboxes only: Home's widget set to one. */
const WAITING_COUNT_IN_SQL = `${WAITING_SOURCE} select count(*)::int as n from waiting where account_id::text = any($3::text[])`;

/** The rows worth raising this tick: newest first, capped. */
const WAITING_ROWS_SQL = `${WAITING_SOURCE}
  select thread_id, thread_subject, message_id, from_addr, subject, body_text, snippet, age_days
    from waiting
   order by at desc, thread_id asc
   limit $3`;

export function createWaitingOnMeSentinel(): Sentinel {
  return {
    id: 'email.waiting-on-me',
    description:
      'Reports conversations waiting on you for longer than your setting (2 days by default), ' +
      'from people you have written to before or who asked you something — never alerts, newsletters or muted threads.',
    every: EVERY_12H,
    async run(ctx: SentinelContext): Promise<SentinelReport> {
      const settings = await loadWatcherSettings(ctx.buddi!.db);
      const bounds = [ctx.buddi!.clock.now(), settings.waitingDays];
      // Everything that is still true, and then the few worth saying out loud.
      const all = await ctx.buddi!.db.query(WAITING_KEYS_SQL, bounds);
      const keys = all.rows.map((row: Record<string, any>) =>
        waitingKey(String(row.thread_id), String(row.message_id)),
      );
      const { rows } = await ctx.buddi!.db.query(WAITING_ROWS_SQL, [...bounds, MAX_WAITING_FINDINGS]);
      const agentId = mailAgent(ctx);
      const findings: Finding[] = rows
        .map((row: Record<string, any>) => {
          const thread: WaitingThread = {
            threadId: String(row.thread_id),
            subject: row.subject || row.thread_subject || '',
            from: row.from_addr ?? '',
            lastInboundId: String(row.message_id),
            ageDays: Math.max(0, Number(row.age_days ?? 0)),
            firstLine: firstLineOf(row.body_text ?? row.snippet ?? ''),
          };
          const finding = waitingFinding(thread);
          return { ...finding, ...(agentId ? { agentId } : {}) };
        });
      return { findings, keys };
    },
  };
}

export const waitingOnMe: Sentinel = createWaitingOnMeSentinel();

/**
 * The count, over whatever `db` it is handed — the read-only pool included.
 *
 * It reads the owner's `waitingDays` exactly as the watcher does, so changing
 * the setting moves the watcher and the goal together.
 */
export async function countWaitingOnMe(
  db: Parameters<typeof loadWatcherSettings>[0],
  now: Date,
  accountIds?: readonly string[],
): Promise<number> {
  const settings = await loadWatcherSettings(db);
  return countWaiting(db, now, settings.waitingDays, accountIds);
}

/**
 * How many conversations need the owner now: the one rule with no waiting
 * age. The widget's number, and exactly the Mail page's "Needs a reply".
 */
export async function countNeedsYou(
  db: Pick<DbArea, 'query'>,
  now: Date,
  accountIds?: readonly string[],
): Promise<number> {
  return countWaiting(db, now, 0, accountIds);
}

async function countWaiting(
  db: Pick<DbArea, 'query'>,
  now: Date,
  minDays: number,
  accountIds?: readonly string[],
): Promise<number> {
  const bounds = [now, minDays];
  const { rows } = accountIds
    ? await db.query(WAITING_COUNT_IN_SQL, [...bounds, [...accountIds]])
    : await db.query(WAITING_COUNT_SQL, bounds);
  return Number((rows[0] as { n: unknown } | undefined)?.n ?? 0);
}
