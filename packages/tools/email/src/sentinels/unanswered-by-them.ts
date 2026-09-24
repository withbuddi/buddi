/**
 * `email.unanswered-by-them` — the owner asked, and nobody answered.
 *
 * docs/specs/email.md §7: *«the owner wrote to someone N days ago and nothing
 * came back; a nudge, once»*. The mirror of `email.waiting-on-me`, and the
 * conditions are the mirror of its conditions — every one of them there to keep
 * a helpful watcher from making the owner look impatient:
 *
 *  - **the owner wrote it**, out of the Sent folder, inside the last month;
 *  - **it was not a reply to them.** A conversation they started is one they
 *    are already in; an answer to their mail that they have not answered back
 *    is ordinary, and `email.waiting-on-me` is not raised about the owner for
 *    the same reason;
 *  - **it asked something**, decided by `phrases.ts` over the owner's own
 *    words: a question mark that ends a sentence, or one of the pinned polite
 *    asks in English or French. A message that told somebody something is not
 *    waiting for anything;
 *  - **nothing came back from that address** on that conversation since;
 *  - **the owner has not already nudged**, which is any later outbound message
 *    on the thread — whatever it says, he has been back in touch;
 *  - **not a newsletter, not a no-reply address, not a muted conversation, not
 *    a silenced correspondent.** Nobody is waiting on an answer from
 *    `noreply@`.
 *
 * `info`, once, and the finding offers a *draft*. The nudge is the owner's to
 * send, from the card; nothing here sends, and nothing here writes the words
 * either — the agent reads the thread first and may well decide there is
 * nothing to chase.
 */
import type { Finding, Sentinel, SentinelContext, SentinelReport } from '@buddi/core/plugin';
import { looksUnreplyable } from '../mail.js';
import { findQuestion } from '../phrases.js';
import {
  NUDGE_WINDOW_DAYS,
  historyWindowDays,
  loadWatcherSettings,
  nudgeFinding,
  type UnansweredAsk,
} from '../watchers.js';
import { cameAfter, cameBefore } from './order.js';
import { mailAgent } from './waiting-on-me.js';

/** Daily. A nudge is a thing the owner does once, not a thing he is reminded of. */
export const EVERY_DAY = 24 * 60 * 60;

/** At most this many findings in one tick. */
export const MAX_NUDGE_FINDINGS = 20;

/**
 * The owner's own unanswered openings.
 *
 * `$1` now, `$2` the setting, `$3` the ceiling. Every exclusion is a `not
 * exists` over the same conversation, so the whole of "nobody answered, and he
 * has not chased" is one statement and nothing in it judges: whether the
 * message *asked* anything is `phrases.ts`'s, over the rows this returns.
 */
const UNANSWERED_SQL = `
  with rows as (
    select m.id, m.account_id, m.thread_id, m.subject, m.body_text, m.to_addrs, m.cc,
           coalesce(m.internal_date, m.fetched_at) as at
      from email.messages m
      join email.threads t on t.id = m.thread_id
     where m.direction = 'out'
       and t.state <> 'muted'
       and coalesce(m.internal_date, m.fetched_at) <= $1::timestamptz - make_interval(days => $2::int)
       and coalesce(m.internal_date, m.fetched_at) >= $1::timestamptz - make_interval(days => $3::int)
       /*
        * Not a reply to *their* message.
        *
        * "Their" is the point, and it used to be missing: any earlier inbound
        * on the conversation suppressed the finding, so an introduction from C
        * that the owner then answered with an original question to B was
        * silently dropped — a three-party thread is the ordinary shape of
        * work, not an edge case. The earlier message only makes this a reply
        * when it came from somebody this message is addressed to.
        */
       and not exists (
         select 1 from email.messages prev
         cross join lateral (
           select jsonb_array_elements_text(m.to_addrs) as addr
           union all
           select jsonb_array_elements_text(m.cc) as addr
         ) p
          where prev.thread_id = m.thread_id
            and prev.direction = 'in'
            and prev.id <> m.id
            and ${cameBefore('prev', 'm')}
            and email.address_of(prev.from_addr) = email.address_of(p.addr)
       )
       -- Nothing came back from anybody he addressed it to.
       and not exists (
         select 1 from email.messages inb
         cross join lateral (
           select jsonb_array_elements_text(m.to_addrs) as addr
           union all
           select jsonb_array_elements_text(m.cc) as addr
         ) a
          where inb.thread_id = m.thread_id
            and inb.direction = 'in'
            and inb.id <> m.id
            -- order.ts's comparison, not a bare instant: the id is random.
            and ${cameAfter('inb', 'm')}
            and email.address_of(inb.from_addr) = email.address_of(a.addr)
       )
       -- He has not already been back in touch.
       and not exists (
         select 1 from email.messages later
          where later.thread_id = m.thread_id
            and later.direction = 'out'
            and later.id <> m.id
            and ${cameAfter('later', 'm')}
       )
       -- Not a broadcast: a conversation any message of which carries a
       -- List-Id is a mailing list, and nobody there owes him an answer.
       and not exists (
         select 1 from email.messages n
          where n.thread_id = m.thread_id and n.list_id is not null
       )
  )
  select id, thread_id, subject, body_text, to_addrs,
         floor(extract(epoch from ($1::timestamptz - at)) / 86400.0)::int as age_days
    from rows
   where not exists (
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
   )
   order by at desc, id asc`;

/** The addresses a row went to, in order. */
function recipients(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).filter(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
}

export function createUnansweredByThemSentinel(): Sentinel {
  return {
    id: 'email.unanswered-by-them',
    description:
      'Reports a message you sent that asked something and has had no answer, and offers to draft a nudge. ' +
      'It never sends one.',
    every: EVERY_DAY,
    async run(ctx: SentinelContext): Promise<SentinelReport> {
      const settings = await loadWatcherSettings(ctx.buddi!.db);
      // The window contains the setting: a `nudgeDays` of 45 against a fixed
      // thirty-day ceiling reported nothing at all. See `historyWindowDays`.
      const { rows } = await ctx.buddi!.db.query(UNANSWERED_SQL, [
        ctx.buddi!.clock.now(),
        settings.nudgeDays,
        historyWindowDays(settings.nudgeDays, NUDGE_WINDOW_DAYS),
      ]);
      const agentId = mailAgent(ctx);

      const keys: string[] = [];
      const findings: Finding[] = [];
      for (const row of rows as Array<Record<string, any>>) {
        const to = recipients(row.to_addrs);
        // A machine that does not read its mail is not keeping anybody waiting.
        if (to.length === 0 || to.every((address) => looksUnreplyable(address))) continue;
        const question = findQuestion(row.body_text ?? '');
        if (question === null) continue;
        const ask: UnansweredAsk = {
          threadId: String(row.thread_id),
          messageId: String(row.id),
          subject: row.subject ?? '',
          to: to.find((address) => !looksUnreplyable(address)) ?? to[0] ?? '(nobody)',
          phrase: question.phrase,
          ageDays: Math.max(0, Number(row.age_days ?? 0)),
        };
        const finding = nudgeFinding(ask);
        keys.push(finding.key);
        if (findings.length >= MAX_NUDGE_FINDINGS) continue;
        findings.push({ ...finding, ...(agentId ? { agentId } : {}) });
      }
      return { findings, keys };
    },
  };
}

export const unansweredByThem: Sentinel = createUnansweredByThemSentinel();
