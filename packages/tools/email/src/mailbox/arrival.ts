/**
 * Rules that act in the mailbox when mail arrives.
 *
 * A policy may carry an on-arrival action (`params.onArrival`: archive, mark
 * read, or move to an existing folder). The gate decides which rule covers a
 * new message, as it always has; this is the one path that then carries out
 * that rule's mailbox action — for a rule the owner wrote, and for a learned
 * rule once it is kept, alike. Every change lands on the undo trail with
 * `origin = policy` and the rule's id, so the owner undoes a rule's work from
 * the same Recent changes list as an agent's.
 *
 * Nothing here asks anybody: the asking happened when the rule was set
 * (`email.set_policy` is gated, and its card says what it will do on
 * arrival). A failure never costs a message its triage — the run is already
 * queued by then — and is logged. A message the rule already acted on (on the
 * trail with its policy id) is never acted on again by it, so a message the
 * poll drains a second time is not changed twice.
 */
import type { DbArea } from '@buddi/core/plugin';
import type { PolicyRecord } from '../policies/gate.js';
import type { AccountRecord } from '../ports.js';
import { loadTargets, performAction, type ActionOutcome, type MailboxActionKind, type WriterOptions, withWriter } from './actions.js';

type Db = Pick<DbArea, 'query'>;

/** One new message a rule with an on-arrival action matched. */
export interface ArrivalMatch {
  messageId: string;
  policy: PolicyRecord;
}

/** The rule in the words a trail row says it: `rule sender news@shop.example`. */
export function ruleActor(policy: PolicyRecord): string {
  return `rule ${policy.scope} ${policy.matcher}`;
}

function kindOf(policy: PolicyRecord): MailboxActionKind | null {
  switch (policy.params.onArrival?.kind) {
    case 'archive':
      return 'archive';
    case 'mark-read':
      return 'mark-read';
    case 'move':
      return 'move';
    default:
      return null;
  }
}

/** The messages among these that this rule has already acted on. */
async function alreadyActed(db: Db, policyId: string, ids: readonly string[]): Promise<Set<string>> {
  const { rows } = await db.query(
    `select distinct unnest(message_ids)::text as id from email.mailbox_actions
      where policy_id = $1 and message_ids && $2::uuid[]`,
    [policyId, ids],
  );
  return new Set(rows.map((r: Record<string, any>) => String(r.id)));
}

/**
 * Carry out the on-arrival actions for these matches on one account: one
 * connection, one change (one trail row) per rule. Returns what each rule did.
 */
export async function applyArrivalActions(
  ctx: { buddi?: import('@buddi/core/plugin').BuddiHost | undefined },
  account: AccountRecord,
  opts: WriterOptions,
  matches: readonly ArrivalMatch[],
): Promise<ActionOutcome[]> {
  const db = ctx.buddi!.db;
  const byPolicy = new Map<string, { policy: PolicyRecord; ids: string[] }>();
  for (const m of matches) {
    if (!kindOf(m.policy)) continue;
    const entry = byPolicy.get(m.policy.id) ?? { policy: m.policy, ids: [] };
    entry.ids.push(m.messageId);
    byPolicy.set(m.policy.id, entry);
  }
  if (byPolicy.size === 0) return [];
  return withWriter(ctx, account, opts, async (client) => {
    const outcomes: ActionOutcome[] = [];
    for (const { policy, ids } of byPolicy.values()) {
      const done = await alreadyActed(db, policy.id, ids);
      const fresh = ids.filter((id) => !done.has(id));
      if (fresh.length === 0) continue;
      const targets = (await loadTargets(db, fresh)).filter((t) => t.accountId === account.id);
      if (targets.length === 0) continue;
      try {
        outcomes.push(
          await performAction(db, client, {
            account,
            kind: kindOf(policy)!,
            targets,
            ...(policy.params.onArrival?.folder ? { folder: policy.params.onArrival.folder } : {}),
            provenance: {
              origin: 'policy',
              actor: ruleActor(policy),
              policyId: policy.id,
              criteria: `new mail matching the rule on ${policy.scope} ${policy.matcher}`,
            },
            now: ctx.buddi!.clock.now(),
          }),
        );
      } catch (err) {
        (ctx.buddi?.log ?? (() => {}))(
          `email.inbox-poll: the rule on ${policy.scope} ${policy.matcher} could not ${policy.params.onArrival?.kind} ` +
            `${targets.length} new message(s) in ${account.address}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return outcomes;
  });
}
