/**
 * Learned rules through the owner's one inbox (docs/specs/learning.md §2 item 3).
 *
 * `learn.ts` decides *whether* a sender's history proposes a rule; this file
 * is how the proposal travels. It goes to `core.proposals` as a `policy`
 * card, beside the skills the agents propose, and this plugin stays the owner
 * of the rule itself:
 *
 *  - **apply** — the owner kept the card: write the rule as a kept row
 *    (`proposed = false`), the only kind the gate reads.
 *  - **revoke** — the owner discarded it: drop any live learned rule this
 *    proposal became. A card that was never kept has none, and says so.
 *  - **adopt** — once, on start: the rows this plugin used to hold with
 *    `proposed = true` move to core as open cards, and the rows go. Kept rows
 *    are untouched. Idempotent: a moved row is no longer there to move.
 *
 * The payload is the plugin's own terms, readable without knowing email:
 * `matcher` is `{ <scope>: <value>, account, accountId }` (the card hides the
 * `…Id` handle), `action` is the gate's action, `params` what it needs, and
 * `verdicts` the triage rows it was learned from. The sources are the
 * messages, by subject and sender; mail is untrusted, so the card is marked.
 */
import type { Pool, PoolClient } from 'pg';
import {
  proposePolicy,
  type PolicyApplyResult,
  type PolicyHandler,
  type PolicyHandlerContext,
  type Proposal,
  type ProposePolicyInput,
  type UntrustedSource,
} from '@buddi/core';
import { POLICY_ACTIONS, POLICY_SCOPES, type PolicyAction, type PolicyParams, type PolicyScope } from './gate.js';
import { createPolicy, normalizeMatcher, refusalFor, PolicyRefusal } from './store.js';

type Db = Pool | PoolClient;

export const EMAIL_PLUGIN = 'email';

/** How a source line names the tool whose verdicts it came from. */
const VIA = 'email.triage_record';

/** One verdict a rule was learned from, as the payload carries it. */
export interface LearnedVerdict {
  messageId: string;
  processingVersion: number;
  category?: string;
  urgency?: string;
}

/** The messages a rule was learned from, as untrusted sources: subject and sender, never the body. */
export async function mailSources(db: Db, messageIds: readonly string[]): Promise<UntrustedSource[]> {
  if (messageIds.length === 0) return [];
  const { rows } = await db.query(
    `select id, subject, from_addr from email.messages where id = any($1::uuid[])`,
    [messageIds],
  );
  const byId = new Map(rows.map((r: Record<string, any>) => [String(r.id), r]));
  return messageIds.map((id) => {
    const row = byId.get(id);
    const subject = String(row?.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const from = String(row?.from_addr ?? '').trim();
    return {
      kind: 'mail' as const,
      via: VIA,
      ref: row ? `"${subject || '(no subject)'}" from ${from || 'an unknown sender'}` : `message ${id}`,
    };
  });
}

/** The account's address, for the card; the id stays the identifying handle. */
async function accountAddress(db: Db, accountId: string): Promise<string | null> {
  const { rows } = await db.query(`select address from email.accounts where id = $1::uuid`, [accountId]);
  return rows[0]?.address ? String(rows[0].address) : null;
}

/** What `proposePolicy` is given for one learned rule. */
export async function learnedPolicyInput(
  db: Db,
  input: {
    accountId: string | null;
    scope?: PolicyScope;
    sender: string;
    action: PolicyAction;
    params: PolicyParams;
    verdicts: LearnedVerdict[];
    why: string;
    sources: UntrustedSource[];
  },
): Promise<ProposePolicyInput> {
  const scope = input.scope ?? 'sender';
  const account = input.accountId ? await accountAddress(db, input.accountId) : null;
  return {
    plugin: EMAIL_PLUGIN,
    matcher: {
      [scope]: input.sender,
      account: account ?? 'every mailbox',
      accountId: input.accountId,
    },
    action: input.action,
    params: input.params as Record<string, unknown>,
    verdicts: input.verdicts,
    why: input.why,
    sources: input.sources,
  };
}

/** The rule a policy payload describes, or why it describes none. */
export function ruleOf(
  payload: Record<string, unknown>,
): { ok: true; scope: PolicyScope; matcher: string; accountId: string | null; action: PolicyAction; params: PolicyParams; verdicts: LearnedVerdict[] } | { ok: false; note: string } {
  if (payload.plugin !== EMAIL_PLUGIN) return { ok: false, note: `this is a rule for ${String(payload.plugin)}, not email.` };
  const matcher = (payload.matcher ?? {}) as Record<string, unknown>;
  const scope = POLICY_SCOPES.find((s) => typeof matcher[s] === 'string');
  if (!scope) return { ok: false, note: 'the rule names no sender, domain, list or thread to match.' };
  const action = String(payload.action ?? '') as PolicyAction;
  if (!POLICY_ACTIONS.includes(action)) return { ok: false, note: `"${action}" is not something email rules do.` };
  const accountId = typeof matcher.accountId === 'string' && matcher.accountId ? matcher.accountId : null;
  const verdicts = (Array.isArray(payload.verdicts) ? payload.verdicts : [])
    .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object' && typeof (v as any).messageId === 'string')
    .map((v) => ({ messageId: String(v.messageId), processingVersion: Number(v.processingVersion ?? 0) }));
  const params = (payload.params && typeof payload.params === 'object' ? payload.params : {}) as PolicyParams;
  return { ok: true, scope, matcher: String(matcher[scope]), accountId, action, params, verdicts };
}

/** Keep: write the rule the gate reads. */
export async function applyLearnedPolicy(proposal: Proposal, ctx: PolicyHandlerContext): Promise<PolicyApplyResult> {
  const rule = ruleOf(proposal.payload);
  if (!rule.ok) return rule;
  const refusal = refusalFor(rule);
  if (refusal) return { ok: false, note: refusal };
  try {
    const policy = await createPolicy(
      ctx.db,
      {
        accountId: rule.accountId,
        scope: rule.scope,
        matcher: rule.matcher,
        action: rule.action,
        params: rule.params,
        origin: 'learned',
        proposed: false,
        createdFrom: rule.verdicts.map((v) => ({ messageId: v.messageId, processingVersion: v.processingVersion })),
      },
      ctx.now,
    );
    return {
      ok: true,
      ref: policy.id,
      note: `Kept; email now ${policy.action === 'ignore' ? 'ignores' : `applies "${policy.action}" to`} mail from ${policy.matcher} with no model run. Revoke it under Settings → Email → Policies.`,
    };
  } catch (err) {
    if (err instanceof PolicyRefusal) return { ok: false, note: err.message };
    throw err;
  }
}

/**
 * Discard: revoke the live learned rule this proposal became, if it became
 * one (the same slot, learned from the same messages). An open card that was
 * discarded never wrote anything, and the answer says so.
 */
export async function revokeLearnedPolicy(proposal: Proposal, ctx: PolicyHandlerContext): Promise<{ note: string }> {
  const rule = ruleOf(proposal.payload);
  if (!rule.ok) return { note: `Nothing to revoke: ${rule.note}` };
  const createdFrom = rule.verdicts.map((v) => ({ messageId: v.messageId, processingVersion: v.processingVersion }));
  const { rows } = await ctx.db.query(
    `update email.policies set revoked_at = $1
      where revoked_at is null and origin = 'learned' and proposed = false
        and scope = $2 and matcher = $3
        and account_id is not distinct from $4::uuid
        and created_from = $5::jsonb
      returning id`,
    [ctx.now, rule.scope, normalizeMatcher(rule.scope, rule.matcher), rule.accountId, JSON.stringify(createdFrom)],
  );
  return {
    note: rows.length > 0 ? `Revoked the email rule about ${rule.matcher}.` : 'Nothing to revoke: it was never kept.',
  };
}

/** Why an adopted row was proposed, when the row did not keep the sentence. */
function adoptedWhy(action: string, count: number): string {
  return action === 'ignore'
    ? `The last ${count} messages from this sender were judged alike and never answered; nothing is lost if you never read them.`
    : `The last ${count} messages from this sender were judged alike; a line when they write may be enough.`;
}

/**
 * Move every live `proposed = true` row into `core.proposals`, once. One
 * transaction: each row becomes a card (or meets the one already waiting, or
 * the owner's discard of the same rule) and is deleted. Kept rows are
 * untouched. Returns how many rows moved.
 */
export async function adoptProposedPolicies(ctx: PolicyHandlerContext): Promise<number> {
  const client = await ctx.db.connect();
  let moved = 0;
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `select id, account_id, scope, matcher, action, params, created_from
         from email.policies
        where proposed = true and revoked_at is null
        order by created_at asc, id asc
        for update`,
    );
    for (const row of rows as Array<Record<string, any>>) {
      const createdFrom: LearnedVerdict[] = (Array.isArray(row.created_from) ? row.created_from : [])
        .filter((v: any) => v && typeof v.messageId === 'string')
        .map((v: any) => ({ messageId: String(v.messageId), processingVersion: Number(v.processingVersion ?? 0) }));
      const params = (row.params ?? {}) as PolicyParams & { note?: string };
      const input = await learnedPolicyInput(client, {
        accountId: row.account_id === null ? null : String(row.account_id),
        scope: row.scope as PolicyScope,
        sender: String(row.matcher),
        action: row.action as PolicyAction,
        params,
        verdicts: createdFrom,
        why: typeof params.note === 'string' && params.note ? params.note : adoptedWhy(row.action, createdFrom.length),
        sources: await mailSources(client, createdFrom.map((v) => v.messageId)),
      });
      await proposePolicy(client, null, input, ctx.now);
      await client.query(`delete from email.policies where id = $1`, [row.id]);
      moved += 1;
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return moved;
}

/** What the email plugin registers with core for kind `policy`. */
/**
 * How many messages the gate acted on this week through a learned rule the
 * owner kept: the digest's "stopped doing". Read from the gate's own audit
 * (`email.events`), where every decision names the policy it applied; a
 * message nothing matched, or an action refused, is not counted.
 */
export async function countLearnedApplications(ctx: PolicyHandlerContext, since: Date): Promise<number> {
  const { rows } = await ctx.db.query(
    `select count(*)::int as n
       from email.events e
       join email.policies p on p.id = e.policy_id
      where p.origin = 'learned' and p.proposed = false
        and e.at >= $1 and e.at <= $2
        and e.action not in ('none', 'refused') and e.status = 'done'`,
    [since, ctx.now],
  );
  return Number(rows[0]?.n ?? 0);
}

export const emailPolicyHandler: PolicyHandler = {
  apply: applyLearnedPolicy,
  revoke: revokeLearnedPolicy,
  adopt: adoptProposedPolicies,
  applied: countLearnedApplications,
};
