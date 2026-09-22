/**
 * `email.promised-reply` — the owner said he would come back to somebody.
 *
 * docs/specs/email.md §7: *«the owner wrote "I'll get back to you" or asked
 * buddi to draft, and nothing was sent within N days»*. Two halves, and they
 * are two different unkept promises:
 *
 *  - **words.** An outbound message of the owner's own, in the last
 *    `PROMISE_WINDOW_DAYS`, whose text contains one of the pinned promise
 *    phrases (`phrases.ts`, English and French) — and nothing outbound has
 *    followed it on that conversation since. The Sent folder is what makes this
 *    readable at all: a promise kept from a phone is a promise kept, and this
 *    watcher sees it.
 *  - **a draft.** A live draft on a conversation, written by an agent at the
 *    owner's request and never sent, older than the same setting. `draft` and
 *    `edited` are the two live statuses; `sent`, `discarded` and `lapsed` are
 *    ends, and a draft claimed by a dispatch (`sent_action_id`) is on the wire
 *    rather than forgotten.
 *
 * The bounds are the usual two. A month is the ceiling — a promise nobody has
 * chased in a month is history, and a mailbox arrives full of them — and the
 * findings are capped, newest first, with every key that is still true returned
 * uncapped so core resolves none of the tail.
 *
 * It never sends anything, and it never drafts anything either. What it hands
 * over is a conversation and the owner's own sentence, for an agent to read
 * before it says a word.
 */
import type { Finding, Sentinel, SentinelContext, SentinelReport } from '@buddi/core';
import { findPromise } from '../phrases.js';
import {
  PROMISE_WINDOW_DAYS,
  loadWatcherSettings,
  promisedDraftFinding,
  promisedFinding,
  type PromisedDraft,
  type PromisedReply,
} from '../watchers.js';
import { mailAgent } from './waiting-on-me.js';

/** Twice a day. A promise is measured in days; more often would say the same. */
export const EVERY_12H = 12 * 60 * 60;

/** At most this many findings in one tick. A backlog is a report, not an alarm. */
export const MAX_PROMISED_FINDINGS = 20;

/** The live-`ignore` test, over every address a row was addressed to. */
const IGNORED_RECIPIENT = `exists (
  select 1
    from email.policies p
   cross join lateral (
     select jsonb_array_elements_text(rows.to_addrs) as addr
     union all
     select jsonb_array_elements_text(rows.cc) as addr
   ) a
   where p.revoked_at is null
     and p.proposed = false
     and p.action = 'ignore'
     and (p.account_id is null or p.account_id = rows.account_id)
     and (
       (p.scope = 'sender' and p.matcher = email.address_of(a.addr))
       or (p.scope = 'domain' and p.matcher = split_part(email.address_of(a.addr), '@', 2))
     )
)`;

/**
 * The owner's own messages that are still the last word he said on a thread.
 *
 * `$1` now, `$2` the setting, `$3` the ceiling. The "nothing followed" test is
 * the whole of "not kept": a second outbound message on the conversation is the
 * owner having come back to them, whatever either message says.
 */
const PROMISES_SQL = `
  with rows as (
    select m.id, m.account_id, m.thread_id, m.subject, m.body_text, m.to_addrs, m.cc,
           coalesce(m.internal_date, m.fetched_at) as at
      from email.messages m
      join email.threads t on t.id = m.thread_id
     where m.direction = 'out'
       and t.state <> 'muted'
       and coalesce(m.internal_date, m.fetched_at) <= $1::timestamptz - make_interval(days => $2::int)
       and coalesce(m.internal_date, m.fetched_at) >= $1::timestamptz - make_interval(days => $3::int)
       and not exists (
         select 1 from email.messages later
          where later.thread_id = m.thread_id
            and later.direction = 'out'
            and coalesce(later.internal_date, later.fetched_at)
                > coalesce(m.internal_date, m.fetched_at)
       )
  )
  select id, thread_id, subject, body_text, to_addrs,
         floor(extract(epoch from ($1::timestamptz - at)) / 86400.0)::int as age_days
    from rows
   where not ${IGNORED_RECIPIENT}
   order by at desc, id asc`;

/** Live drafts nobody has touched for longer than the setting. */
const DRAFTS_SQL = `
  with rows as (
    select d.id, d.account_id, d.thread_id, d.subject, d.to_addrs, d.cc, d.created_by_agent,
           d.updated_at as at
      from email.drafts d
      join email.threads t on t.id = d.thread_id
     where d.status in ('draft', 'edited')
       and d.sent_action_id is null
       and t.state <> 'muted'
       and d.updated_at <= $1::timestamptz - make_interval(days => $2::int)
       and d.updated_at >= $1::timestamptz - make_interval(days => $3::int)
  )
  select id, thread_id, subject, to_addrs, created_by_agent,
         floor(extract(epoch from ($1::timestamptz - at)) / 86400.0)::int as age_days
    from rows
   where not ${IGNORED_RECIPIENT}
   order by at desc, id asc`;

/** Who a row was addressed to, as the finding says it. */
function firstRecipient(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : [];
  const first = list.find((value) => typeof value === 'string' && value.trim() !== '');
  return typeof first === 'string' ? first : '(nobody)';
}

export function createPromisedReplySentinel(): Sentinel {
  return {
    id: 'email.promised-reply',
    description:
      'Reports a conversation where you said you would come back to somebody, or where a draft has been ' +
      'written for you, and nothing has left this mailbox since.',
    every: EVERY_12H,
    async run(ctx: SentinelContext): Promise<SentinelReport> {
      const settings = await loadWatcherSettings(ctx.db);
      const bounds = [ctx.now(), settings.promisedDays, PROMISE_WINDOW_DAYS];
      const agentId = mailAgent(ctx);

      /*
       * Both halves are shaped the same way: every row that is still true goes
       * into `keys`, and only the first `MAX_PROMISED_FINDINGS` become
       * findings. Core resolves every open key a tick did not name, so a
       * promise pushed past the cap has to be named or it reads as kept.
       */
      const keys: string[] = [];
      const findings: Finding[] = [];
      const add = (finding: Finding): void => {
        keys.push(finding.key);
        if (findings.length < MAX_PROMISED_FINDINGS) {
          findings.push({ ...finding, ...(agentId ? { agentId } : {}) });
        }
      };

      const promises = await ctx.db.query(PROMISES_SQL, bounds);
      for (const row of promises.rows as Array<Record<string, any>>) {
        // The judgement is `phrases.ts`'s, over the owner's own words, and it
        // is made here rather than in SQL because a regular expression in a
        // query is a rule nobody can test without a database.
        const promise = findPromise(row.body_text ?? '');
        if (promise === null) continue;
        const shaped: PromisedReply = {
          threadId: String(row.thread_id),
          messageId: String(row.id),
          subject: row.subject ?? '',
          to: firstRecipient(row.to_addrs),
          phrase: promise.phrase,
          ageDays: Math.max(0, Number(row.age_days ?? 0)),
        };
        add(promisedFinding(shaped));
      }

      const drafts = await ctx.db.query(DRAFTS_SQL, bounds);
      for (const row of drafts.rows as Array<Record<string, any>>) {
        const shaped: PromisedDraft = {
          threadId: String(row.thread_id),
          draftId: String(row.id),
          subject: row.subject ?? '',
          to: firstRecipient(row.to_addrs),
          agent: row.created_by_agent ?? 'an agent',
          ageDays: Math.max(0, Number(row.age_days ?? 0)),
        };
        add(promisedDraftFinding(shaped));
      }

      return { findings, keys };
    },
  };
}

export const promisedReply: Sentinel = createPromisedReplySentinel();
