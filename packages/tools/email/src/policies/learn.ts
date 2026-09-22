/**
 * Learning a policy from the owner's own history.
 *
 * docs/email.md §2: *«buddi proposes policies from the owner's own history and
 * the owner keeps or revokes them in one tap.»* The proposing happens here,
 * right after a triage run records its verdict, and it is deliberately timid:
 *
 *  - **Three verdicts, consecutive, consistent.** Two is a coincidence. A
 *    sender judged promo, promo, reply-needed, promo is a sender the owner may
 *    well hear from, and the run is counted from the newest verdict back, so
 *    one dissenting judgement resets it.
 *  - **Nothing applies itself.** A proposal is a row with `proposed = true`;
 *    the gate does not read it, and the settings page shows it under "Learned,
 *    proposed" with Keep and Revoke. Promo is no exception: until the Sent
 *    folder is synced (docs/email.md §13.3), "the owner never wrote back" is
 *    derived from drafts *buddi* sent, so a sender answered from a phone or
 *    from Gmail looks unanswered here. A rule learned from a half-known history
 *    may be suggested; it may not silence anybody by itself. The Learned list
 *    on the settings page is where the owner applies it.
 *  - **The owner writing back vetoes silence.** Any proposal that would stop a
 *    run is refused for a sender the owner has actually sent mail to. A person
 *    who gets answers is not a newsletter, whatever the categories say.
 *  - **History is per account.** Three promos in the personal mailbox say
 *    nothing about the work one. Every query here is filtered by the account
 *    the verdict was recorded in, and so is the policy it writes.
 *
 * The rule is a pure function; the query around it is the only database part.
 */
import type { Pool, PoolClient } from 'pg';
import { normalizeAddress } from '../mail.js';
import { createPolicy, policyForSender, type CreatePolicyInput } from './store.js';
import type { PolicyAction, PolicyRecord } from './gate.js';

type Db = Pool | PoolClient;

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
  // there is for silence — and it is still only a proposal: what "never
  // answered" is derived from is drafts buddi itself sent, which is not the
  // owner's Sent folder.
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
 * Per account for the same reason the verdicts are: a reply sent from the
 * personal mailbox is not evidence about the work one. And, whatever the
 * answer, it is only evidence about mail sent *through buddi* — the Sent folder
 * is not synced yet, which is the whole reason nothing learned here applies
 * itself.
 */
export async function ownerHasRepliedTo(
  db: Db,
  accountId: string,
  address: string,
): Promise<boolean> {
  const matcher = normalizeAddress(address);
  if (matcher === '' || !accountId) return false;
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::int as n from email.drafts d
      where d.sent_at is not null
        and d.account_id = $2::uuid
        and exists (
          select 1 from jsonb_array_elements_text(d.to_addrs) as a(addr)
           where email.address_of(a.addr) = $1
        )`,
    [matcher, accountId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Called after a verdict is recorded. Writes at most one policy and returns it,
 * or null when nothing was learned — which is the usual answer.
 *
 * A sender that already has a live policy learns nothing: whatever is there is
 * either the owner's decision or a proposal they have not looked at yet, and
 * overwriting either would be this plugin arguing with itself.
 */
export async function learnFromVerdict(
  db: Db,
  input: { from: string; accountId: string },
  now: Date,
): Promise<PolicyRecord | null> {
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

  const create: CreatePolicyInput = {
    accountId: input.accountId,
    scope: 'sender',
    matcher: address,
    action: proposal.action,
    params:
      proposal.action === 'ignore'
        ? { category: verdicts[0]?.category ?? 'promo', urgency: 'low' }
        : { note: proposal.why },
    origin: 'learned',
    proposed: proposal.proposed,
    createdFrom: proposal.createdFrom,
  };
  return createPolicy(db, create, now);
}
