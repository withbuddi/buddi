/**
 * `email.waiting-on-me` — a conversation has been waiting on the owner.
 *
 * docs/specs/email.md §7: *«a thread in `waiting-on-me` for more than N days
 * (default 2), from a sender the owner has replied to before»*. Four conditions,
 * and every one of them exists to keep this from being a nag:
 *
 *  - **the thread's state**, which is a fact about the mailbox (who wrote last,
 *    Sent folder included), not a judgement anybody made;
 *  - **the last inbound message is older than the setting**. Age is measured
 *    from INTERNALDATE, never the sender's `Date` header — a forged one would
 *    otherwise make anything look a fortnight old;
 *  - **the owner has written to this sender before**, from this account. A
 *    stranger who has not been answered in two days has not been kept waiting;
 *    that is what an inbox is. It is read from the Sent folder, which is also
 *    why this watcher says nothing at all on an installation whose mailbox has
 *    no Sent folder — honest silence rather than a finding per newsletter;
 *  - **no ignore policy, and not muted.** Both are the owner's decision, and a
 *    watcher that talked past them would be arguing with him.
 *
 * One finding per thread per cycle, keyed to the thread *and* the message that
 * is waiting: a reply arriving means a new key, and core resolves the old one.
 *
 * Two bounds, and they are the difference between a watcher and a nag. The
 * query only looks at the last `STALE_WAITING_DAYS` — a conversation nobody
 * has touched in a month is history, not an alarm — and reports the *newest*
 * waiting threads first, so the raise cap truncates the least urgent rows
 * rather than the most recent ones. The rows past the cap are still returned
 * as keys, so core does not mistake them for answered.
 */
import type { Finding, Sentinel, SentinelContext, SentinelReport } from '@buddi/core';
import {
  STALE_WAITING_DAYS,
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

/**
 * How many waiting threads one tick *looks* at, past the raise cap.
 *
 * The cap above is about how much the owner hears; this is about what the
 * watcher knows. Core resolves every open finding a run did not return, so a
 * thread truncated by the cap would read as answered and come back as news on
 * the next tick — the rows between the two numbers are reported as still true
 * (`SentinelReport.keys`) without being raised again.
 */
export const MAX_WAITING_SCANNED = 500;

/** Who speaks about mail: whoever holds `mail`, else `triage`, else nobody. */
export function mailAgent(ctx: SentinelContext): string | undefined {
  return ctx.agentForRole('mail') ?? ctx.agentForRole('triage');
}

/**
 * The query: threads waiting on the owner, with the last inbound message, its
 * age, and whether the owner has ever written to that sender from that account.
 *
 * It is one statement because every part of it is a fact about the same row,
 * and splitting it would mean deciding in TypeScript what Postgres can decide
 * in the join — but nothing here *judges*: the severity and the words are
 * `watchers.ts`'s, over the rows this returns.
 */
const WAITING_SQL = `
  with last_inbound as (
    select distinct on (m.thread_id)
           m.thread_id, m.id, m.from_addr, m.subject, m.body_text, m.snippet, m.account_id,
           coalesce(m.internal_date, m.fetched_at) as at
      from email.messages m
      join email.threads t on t.id = m.thread_id
     where m.direction = 'in'
       and t.state = 'waiting-on-me'
     order by m.thread_id, coalesce(m.internal_date, m.fetched_at) desc, m.id desc
  )
  select t.id as thread_id, t.subject as thread_subject,
         li.id as message_id, li.from_addr, li.subject, li.body_text, li.snippet,
         floor(extract(epoch from ($1::timestamptz - li.at)) / 86400.0)::int as age_days
    from last_inbound li
    join email.threads t on t.id = li.thread_id
   where t.state = 'waiting-on-me'
     and li.at <= $1::timestamptz - make_interval(days => $2::int)
     -- ...and not so old that it is history rather than news. See
     -- STALE_WAITING_DAYS above: a mailbox arrives with years of inbound-last
     -- threads, and a watcher that reported all of them would wake the owner
     -- twenty times a day about mail from 2019 forever.
     and li.at >= $1::timestamptz - make_interval(days => $3::int)
     -- The owner has written to them before, from this mailbox: his own mail,
     -- whatever client he typed it in (docs/specs/email.md §5's departure).
     and exists (
       select 1 from email.messages o
        where o.account_id = li.account_id
          and o.direction = 'out'
          and (
            exists (select 1 from jsonb_array_elements_text(o.to_addrs) as a(addr)
                     where email.address_of(a.addr) = email.address_of(li.from_addr))
            or exists (select 1 from jsonb_array_elements_text(o.cc) as a(addr)
                        where email.address_of(a.addr) = email.address_of(li.from_addr))
          )
     )
     -- Silenced senders stay silenced. A live ignore policy of the owner's on
     -- the sender or their domain, in this mailbox or in every one.
     and not exists (
       select 1 from email.policies p
        where p.revoked_at is null
          and p.proposed = false
          and p.action = 'ignore'
          and (p.account_id is null or p.account_id = li.account_id)
          and (
            (p.scope = 'sender' and p.matcher = email.address_of(li.from_addr))
            or (p.scope = 'domain'
                and p.matcher = split_part(email.address_of(li.from_addr), '@', 2))
          )
     )
   order by li.at desc, t.id asc
   limit $4`;

export function createWaitingOnMeSentinel(): Sentinel {
  return {
    id: 'email.waiting-on-me',
    description:
      'Reports conversations waiting on you for longer than your setting (2 days by default), ' +
      'from people you have written to before.',
    every: EVERY_12H,
    async run(ctx: SentinelContext): Promise<SentinelReport> {
      const settings = await loadWatcherSettings(ctx.db);
      const { rows } = await ctx.db.query(WAITING_SQL, [
        ctx.now(),
        settings.waitingDays,
        STALE_WAITING_DAYS,
        MAX_WAITING_SCANNED,
      ]);
      const agentId = mailAgent(ctx);
      // Every row is a fact that is still true; only the newest few are raised.
      const keys = rows.map((row: Record<string, any>) =>
        waitingKey(String(row.thread_id), String(row.message_id)),
      );
      const findings: Finding[] = rows
        .slice(0, MAX_WAITING_FINDINGS)
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
