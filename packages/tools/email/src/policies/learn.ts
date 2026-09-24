/**
 * Learning a policy from the owner's own history.
 *
 * docs/specs/email.md §2: *«buddi proposes policies from the owner's own history and
 * the owner keeps or revokes them in one tap.»* The proposing happens here,
 * right after a triage run records its verdict, and it is deliberately timid:
 *
 *  - **Three verdicts, consecutive, consistent.** Two is a coincidence. A
 *    sender judged promo, promo, reply-needed, promo is a sender the owner may
 *    well hear from, and the run is counted from the newest verdict back, so
 *    one dissenting judgement resets it.
 *  - **Nothing applies itself.** A proposal is a card on the owner's
 *    Settings → Proposals inbox (`core.proposals`, docs/specs/learning.md §2
 *    item 3), beside what the agents propose; this plugin writes no rule until
 *    the owner keeps it there, and then writes it through its own apply
 *    (`learned.ts`). The gate reads only kept rows. Promo is no exception. Since step 3 the
 *    Sent folder is synced, so "the owner never wrote back" is read off his own
 *    mail rather than inferred from drafts buddi sent — but a mailbox is synced
 *    from *now*, not from its beginning, and a sender answered before buddi
 *    arrived still looks unanswered. Silencing somebody on a history this
 *    installation has only part of stays the owner's tap to make.
 *  - **The owner writing back vetoes silence.** Any proposal that would stop a
 *    run is refused for a sender the owner has actually sent mail to. A person
 *    who gets answers is not a newsletter, whatever the categories say.
 *  - **History is per account.** Three promos in the personal mailbox say
 *    nothing about the work one. Every query here is filtered by the account
 *    the verdict was recorded in, and so is the policy it writes.
 *
 * The rule is a pure function; the query around it is the only database part.
 */
import type { DbArea } from '@buddi/core/plugin';
import type { ProposalsArea, Proposal as CoreProposal, ToolContext } from '@buddi/core/plugin';
import { normalizeAddress } from '../mail.js';
import { policyForSender } from './store.js';
import type { PolicyAction } from './gate.js';
import { learnedPolicyInput, mailSources } from './learned.js';

/** `ctx.buddi.db`, a transaction's handle, or anything that answers a query as they do. */
type Db = Pick<DbArea, 'query'>;

/** How many verdicts running make a pattern. Three: two is a coincidence. */
export const CONSISTENT_VERDICTS = 3;

export interface Verdict {
  messageId: string;
  processingVersion: number;
  category: string;
  urgency: string;
  decidedAt: string | null;
}

export interface Proposal {
  action: PolicyAction;
  /** Always true today: nothing learned applies itself. See the module note. */
  proposed: boolean;
  /** The verdicts it was learned from, newest first. */
  createdFrom: Array<{ messageId: string; processingVersion: number }>;
  /** One line, owner-facing, saying why. */
  why: string;
}

/**
 * What, if anything, this sender's history proposes. Newest verdict first.
 *
 * Returns null far more often than not, and that is the intended behaviour: a
 * proposal the owner has to read and dismiss costs more than a run.
 */
export function learnedProposal(
  verdicts: readonly Verdict[],
  ownerHasReplied: boolean,
): Proposal | null {
  const run = verdicts.slice(0, CONSISTENT_VERDICTS);
  if (run.length < CONSISTENT_VERDICTS) return null;

  const createdFrom = run.map((v) => ({
    messageId: v.messageId,
    processingVersion: v.processingVersion,
  }));
  const category = run[0]!.category;
  const sameCategory = run.every((v) => v.category === category);
  const allLow = run.every((v) => v.urgency === 'low');

  // Marketing, three times running, never answered. It is the strongest case
  // there is for silence — and it is still only a proposal: "never answered"
  // is now read from the owner's own Sent folder, but a folder synced from the
  // day buddi arrived cannot speak for the years before it.
  if (sameCategory && category === 'promo' && !ownerHasReplied) {
    return {
      action: 'ignore',
      proposed: true,
      createdFrom,
      why: `The last ${CONSISTENT_VERDICTS} messages from this sender were all marketing, and nothing here says you ever wrote back.`,
    };
  }
  // Anything else that would silence a sender is proposed too.
  if (allLow && !ownerHasReplied) {
    return {
      action: 'ignore',
      proposed: true,
      createdFrom,
      why: `The last ${CONSISTENT_VERDICTS} messages from this sender were all judged low — nothing is lost if you never read them.`,
    };
  }
  // A person who keeps needing an answer is worth a line, not a run each time.
  if (sameCategory && (category === 'reply-needed' || category === 'relationship')) {
    return {
      action: 'notify',
      proposed: true,
      createdFrom,
      why: `The last ${CONSISTENT_VERDICTS} messages from this sender were all ${category}; a line when they write may be enough.`,
    };
  }
  return null;
}

/**
 * The current verdict per message from one sender **in one account**, newest
 * first.
 *
 * `accountId` is required and not defaulted. A sender's history is a fact about
 * a mailbox: two promos in the personal inbox and one in the work inbox are not
 * three promos at work, and a policy scoped to the work account must not be
 * learned from mail that never arrived there. The same filtering is what keeps
 * the history shown to a triage run about the mailbox it is triaging.
 */
export async function senderVerdicts(
  db: Db,
  accountId: string,
  address: string,
  limit: number = CONSISTENT_VERDICTS,
): Promise<Verdict[]> {
  const matcher = normalizeAddress(address);
  if (matcher === '' || !accountId) return [];
  const { rows } = await db.query(
    `select message_id, processing_version, category, urgency, decided_at, at
       from (
         select distinct on (t.message_id)
                t.message_id, t.processing_version, t.category, t.urgency, t.decided_at,
                coalesce(m.date, m.fetched_at) as at
           from email.triage t
           join email.messages m on m.id = t.message_id
          where email.address_of(m.from_addr) = $1
            and m.account_id = $3::uuid
          order by t.message_id, t.processing_version desc
       ) v
      order by at desc, message_id desc
      limit $2`,
    [matcher, limit, accountId],
  );
  return rows.map((row: Record<string, any>) => ({
    messageId: String(row.message_id),
    processingVersion: Number(row.processing_version),
    category: row.category,
    urgency: row.urgency,
    decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : (row.decided_at ?? null),
  }));
}

/**
 * Has the owner ever actually sent anything to this address *from this account*?
 *
 * Answered from the **Sent folder** since step 3: a message with
 * `direction: out` addressed to them. That is the owner's own mail, whatever
 * client he wrote it in, and it replaces the old inference from buddi's drafts
 * — which could only ever see the replies buddi itself had sent, and therefore
 * called a correspondent of ten years "never answered" if the answers were
 * typed on a phone.
 *
 * The `drafts` table stays what it always was: what buddi drafted and sent
 * through its own tool. It is a record of this machine's actions, not of the
 * owner's correspondence, and the two questions are no longer the same one.
 *
 * Per account, still: a reply sent from the personal mailbox is not evidence
 * about the work one.
 */
export async function ownerHasRepliedTo(
  db: Db,
  accountId: string,
  address: string,
): Promise<boolean> {
  const matcher = normalizeAddress(address);
  if (matcher === '' || !accountId) return false;
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::int as n from email.messages m
      where m.account_id = $2::uuid
        and m.direction = 'out'
        and (
          exists (
            select 1 from jsonb_array_elements_text(m.to_addrs) as a(addr)
             where email.address_of(a.addr) = $1
          )
          or exists (
            select 1 from jsonb_array_elements_text(m.cc) as a(addr)
             where email.address_of(a.addr) = $1
          )
        )`,
    [matcher, accountId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** How many recent outbound messages are counted when measuring a habit. */
export const REPLY_SAMPLE = 50;

export interface OwnerReplies {
  /** How many of the owner's messages went to this address (recent sample). */
  count: number;
  lastAt: string | null;
  /**
   * Mean hours between their message and the owner's answer in the same
   * thread, over the replies where both ends are known. Null when none are.
   */
  averageHours: number | null;
}

/**
 * How often the owner writes back to this address, and how quickly.
 *
 * docs/specs/email.md §6 asks a triage run to be told *«how many times the owner
 * replied and how fast»*. "How fast" is measured the only way that means
 * anything: inside a thread, from their message to the owner's next one. A
 * reply with nothing before it in the thread is counted as a reply and left
 * out of the average rather than guessed at.
 */
export async function ownerReplies(
  db: Db,
  accountId: string,
  address: string,
): Promise<OwnerReplies> {
  const matcher = normalizeAddress(address);
  if (matcher === '' || !accountId) return { count: 0, lastAt: null, averageHours: null };
  const { rows } = await db.query(
    `with sent as (
       select m.thread_id, coalesce(m.internal_date, m.fetched_at) as at
         from email.messages m
        where m.account_id = $2::uuid
          and m.direction = 'out'
          and (
            exists (select 1 from jsonb_array_elements_text(m.to_addrs) as a(addr)
                     where email.address_of(a.addr) = $1)
            or exists (select 1 from jsonb_array_elements_text(m.cc) as a(addr)
                        where email.address_of(a.addr) = $1)
          )
        order by at desc
        limit $3
     ),
     paired as (
       select s.at,
              (select max(coalesce(i.internal_date, i.fetched_at))
                 from email.messages i
                where i.thread_id = s.thread_id
                  and i.direction = 'in'
                  and email.address_of(i.from_addr) = $1
                  and coalesce(i.internal_date, i.fetched_at) <= s.at) as asked_at
         from sent s
     )
     select count(*)::int as n,
            max(at) as last_at,
            avg(extract(epoch from (at - asked_at)) / 3600.0)
              filter (where asked_at is not null) as hours
       from paired`,
    [matcher, accountId, REPLY_SAMPLE],
  );
  const row = rows[0] ?? {};
  const hours = row.hours === null || row.hours === undefined ? null : Number(row.hours);
  return {
    count: Number(row.n ?? 0),
    lastAt: row.last_at instanceof Date ? row.last_at.toISOString() : (row.last_at ?? null),
    averageHours: hours === null || !Number.isFinite(hours) ? null : hours,
  };
}

/** What `learnFromVerdict` proposed: a new card on the owner's inbox. */
export interface LearnedPolicy {
  proposal: CoreProposal;
  action: PolicyAction;
  matcher: string;
}

/**
 * Called after a verdict is recorded. Proposes at most one rule on the
 * owner's Proposals inbox and returns it, or null when nothing was learned —
 * which is the usual answer. The rule itself is written only when the owner
 * keeps the card (`learned.ts`, `applyLearnedPolicy`).
 *
 * A sender that already has a live policy learns nothing: whatever is there is
 * the owner's decision, and overwriting it would be this plugin arguing with
 * itself. A card already waiting for the same rule, or one the owner discarded
 * in the last 90 days, is not proposed again (core's fingerprint).
 *
 * `run` is the triage call that noticed: its agent, conversation and run are
 * the proposal's provenance. The verdicts were made on mail, which is
 * untrusted, so the messages are the proposal's sources — by subject and
 * sender, never by body.
 */
export async function learnFromVerdict(
  db: Db,
  proposals: ProposalsArea,
  input: { from: string; accountId: string },
  now: Date,
  run: Pick<ToolContext, 'agentId' | 'conversationId' | 'toolUseId' | 'provenance'> | null = null,
): Promise<LearnedPolicy | null> {
  const address = normalizeAddress(input.from);
  // No account is no learning. A policy learned from "every mailbox" would be a
  // rule about mail it was never shown.
  if (address === '' || !input.accountId) return null;
  const existing = await policyForSender(db, address, input.accountId);
  if (existing) return null;

  const verdicts = await senderVerdicts(db, input.accountId, address);
  const replied = await ownerHasRepliedTo(db, input.accountId, address);
  const proposal = learnedProposal(verdicts, replied);
  if (!proposal) return null;

  const ask = await learnedPolicyInput(db, {
    accountId: input.accountId,
    sender: address,
    action: proposal.action,
    params:
      proposal.action === 'ignore'
        ? { category: verdicts[0]?.category ?? 'promo', urgency: 'low' }
        : { note: proposal.why },
    verdicts: verdicts.slice(0, CONSISTENT_VERDICTS).map((v) => ({
      messageId: v.messageId,
      processingVersion: v.processingVersion,
      category: v.category,
      urgency: v.urgency,
    })),
    why: proposal.why,
    sources: await mailSources(db, proposal.createdFrom.map((v) => v.messageId)),
  });
  const result = await proposals.proposePolicy(run, ask);
  if (!result.ok) return null;
  return { proposal: result.proposal, action: proposal.action, matcher: address };
}
