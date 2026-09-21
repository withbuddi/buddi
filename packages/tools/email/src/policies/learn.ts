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
 *  - **Nothing applies itself, with one exception.** A proposal is a row with
 *    `proposed = true`; the gate does not read it, and the settings page shows
 *    it under "Learned, proposed" with Keep and Revoke. The exception is §3's:
 *    `ignore` for a sender with three promo verdicts the owner has never
 *    written back to, which applies at once and is listed for revocation.
 *  - **The owner writing back vetoes silence.** Any proposal that would stop a
 *    run is refused for a sender the owner has actually sent mail to. A person
 *    who gets answers is not a newsletter, whatever the categories say.
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
  /** False only for the one exception: promo ignore with no reply ever sent. */
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

  // The exception, and the only thing that ever applies itself.
  if (sameCategory && category === 'promo' && !ownerHasReplied) {
    return {
      action: 'ignore',
      proposed: false,
      createdFrom,
      why: `The last ${CONSISTENT_VERDICTS} messages from this sender were all marketing, and you have never written back.`,
    };
  }
  // Anything else that would silence a sender is proposed, never applied.
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

/** The current verdict per message from one sender, newest first. */
export async function senderVerdicts(
  db: Db,
  address: string,
  limit: number = CONSISTENT_VERDICTS,
): Promise<Verdict[]> {
  const matcher = normalizeAddress(address);
  if (matcher === '') return [];
  const { rows } = await db.query(
    `select message_id, processing_version, category, urgency, decided_at, at
       from (
         select distinct on (t.message_id)
                t.message_id, t.processing_version, t.category, t.urgency, t.decided_at,
                coalesce(m.date, m.fetched_at) as at
           from email.triage t
           join email.messages m on m.id = t.message_id
          where email.address_of(m.from_addr) = $1
          order by t.message_id, t.processing_version desc
       ) v
      order by at desc, message_id desc
      limit $2`,
    [matcher, limit],
  );
  return rows.map((row: Record<string, any>) => ({
    messageId: String(row.message_id),
    processingVersion: Number(row.processing_version),
    category: row.category,
    urgency: row.urgency,
    decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : (row.decided_at ?? null),
  }));
}

/** Has the owner ever actually sent anything to this address? */
export async function ownerHasRepliedTo(db: Db, address: string): Promise<boolean> {
  const matcher = normalizeAddress(address);
  if (matcher === '') return false;
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::int as n from email.drafts d
      where d.sent_at is not null
        and exists (
          select 1 from jsonb_array_elements_text(d.to_addrs) as a(addr)
           where email.address_of(a.addr) = $1
        )`,
    [matcher],
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
  input: { from: string; accountId?: string | null },
  now: Date,
): Promise<PolicyRecord | null> {
  const address = normalizeAddress(input.from);
  if (address === '') return null;
  const existing = await policyForSender(db, address, input.accountId ?? null);
  if (existing) return null;

  const verdicts = await senderVerdicts(db, address);
  const replied = await ownerHasRepliedTo(db, address);
  const proposal = learnedProposal(verdicts, replied);
  if (!proposal) return null;

  const create: CreatePolicyInput = {
    accountId: input.accountId ?? null,
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
