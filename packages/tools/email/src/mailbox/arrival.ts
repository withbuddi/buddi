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
 * queued by then — and is logged. The action is owed in `email.arrival_pending`
 * (migration 019), written before the message's triage stamp, so one whose
 * connection failed is retried by the next poll, up to
 * `ARRIVAL_MAX_ATTEMPTS` times. A message the rule already acted on (on the
 * trail with its policy id) is never acted on again by it, so a retry, or a
 * message the poll drains a second time, is not changed twice.
 */
import type { DbArea } from '@buddi/core/plugin';
import { isLive, type PolicyRecord } from '../policies/gate.js';
import { loadPolicies } from '../policies/store.js';
import type { AccountRecord } from '../ports.js';
import { loadTargets, MailboxLoginRefusal, performAction, type ActionOutcome, type MailboxActionKind, type WriterOptions, withWriter } from './actions.js';

type Db = Pick<DbArea, 'query'>;

/** How many polls try an owed on-arrival action before leaving it. */
export const ARRIVAL_MAX_ATTEMPTS = 5;

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
 * Owe a rule's on-arrival action on a message. Written before the message's
 * triage stamp (or in the ignore's transaction), so a stamped message whose
 * action has not happened is never forgotten. Idempotent.
 */
export async function oweArrivalAction(db: Db, accountId: string, match: ArrivalMatch): Promise<void> {
  if (!kindOf(match.policy)) return;
  await db.query(
    `insert into email.arrival_pending (message_id, policy_id, account_id) values ($1, $2, $3)
     on conflict (message_id, policy_id) do nothing`,
    [match.messageId, match.policy.id, accountId],
  );
}

async function settle(db: Db, policyId: string, ids: readonly string[]): Promise<void> {
  await db.query(`delete from email.arrival_pending where policy_id = $1 and message_id = any($2::uuid[])`, [policyId, ids]);
}

/** One more failed try; returns how many of these rows have now used their last. */
async function failed(db: Db, policyId: string, ids: readonly string[], err: unknown, now: Date): Promise<number> {
  const { rows } = await db.query(
    `update email.arrival_pending set attempts = attempts + 1, last_error = $3, updated_at = $4
      where policy_id = $1 and message_id = any($2::uuid[])
      returning attempts`,
    [policyId, ids, err instanceof Error ? err.message : String(err), now],
  );
  return rows.filter((r: Record<string, any>) => Number(r.attempts) >= ARRIVAL_MAX_ATTEMPTS).length;
}

/**
 * Carry out every on-arrival action this account still owes: the ones this
 * poll just drained, and any an earlier poll could not finish. One
 * connection, one change (one trail row) per rule. A rule that was revoked,
 * or no longer acts on arrival, is owed nothing.
 */
export async function applyPendingArrivals(
  ctx: { buddi?: import('@buddi/core/plugin').BuddiHost | undefined },
  account: AccountRecord,
  opts: WriterOptions,
): Promise<ActionOutcome[]> {
  const db = ctx.buddi!.db;
  const { rows } = await db.query(
    `select message_id::text as message_id, policy_id::text as policy_id from email.arrival_pending
      where account_id = $1 and attempts < $2 order by created_at`,
    [account.id, ARRIVAL_MAX_ATTEMPTS],
  );
  if (rows.length === 0) return [];
  const policies = new Map((await loadPolicies(db, account.id)).map((p) => [p.id, p]));
  const matches: ArrivalMatch[] = [];
  const gone = new Map<string, string[]>();
  for (const r of rows as Array<{ message_id: string; policy_id: string }>) {
    const policy = policies.get(r.policy_id);
    if (policy && isLive(policy, account.id) && kindOf(policy)) matches.push({ messageId: r.message_id, policy });
    else gone.set(r.policy_id, [...(gone.get(r.policy_id) ?? []), r.message_id]);
  }
  for (const [policyId, ids] of gone) await settle(db, policyId, ids);
  return applyArrivalActions(ctx, account, opts, matches);
}

/**
 * Carry out the on-arrival actions for these matches on one account: one
 * connection, one change (one trail row) per rule. Returns what each rule did.
 * Each rule's owed rows are settled once it acted (or had nothing to do), and
 * counted as one more try when it failed.
 */
export async function applyArrivalActions(
  ctx: { buddi?: import('@buddi/core/plugin').BuddiHost | undefined },
  account: AccountRecord,
  opts: WriterOptions,
  matches: readonly ArrivalMatch[],
): Promise<ActionOutcome[]> {
  const db = ctx.buddi!.db;
  const log = ctx.buddi?.log ?? (() => {});
  const byPolicy = new Map<string, { policy: PolicyRecord; ids: string[] }>();
  for (const m of matches) {
    if (!kindOf(m.policy)) continue;
    const entry = byPolicy.get(m.policy.id) ?? { policy: m.policy, ids: [] };
    entry.ids.push(m.messageId);
    byPolicy.set(m.policy.id, entry);
  }
  if (byPolicy.size === 0) return [];
  const failure = async (policy: PolicyRecord, ids: readonly string[], err: unknown): Promise<void> => {
    const why = err instanceof Error ? err.message : String(err);
    const spent = await failed(db, policy.id, ids, err, ctx.buddi!.clock.now());
    log(
      `email.inbox-poll: the rule on ${policy.scope} ${policy.matcher} could not ${policy.params.onArrival?.kind} ` +
        `${ids.length} new message(s) in ${account.address}: ${why}` +
        (spent > 0 ? `; gave up on ${spent} after ${ARRIVAL_MAX_ATTEMPTS} tries` : '; the next poll tries again'),
    );
  };
  const settled = new Set<string>();
  try {
    return await withWriter(ctx, account, opts, async (client) => {
      const outcomes: ActionOutcome[] = [];
      for (const { policy, ids } of byPolicy.values()) {
        const done = await alreadyActed(db, policy.id, ids);
        const fresh = ids.filter((id) => !done.has(id));
        const targets = fresh.length === 0 ? [] : (await loadTargets(db, fresh)).filter((t) => t.accountId === account.id);
        if (targets.length === 0) {
          await settle(db, policy.id, ids);
          settled.add(policy.id);
          continue;
        }
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
          await settle(db, policy.id, ids);
        } catch (err) {
          await failure(policy, ids, err);
        }
        settled.add(policy.id);
      }
      return outcomes;
    });
  } catch (err) {
    // The mailbox needs a password: nothing was tried, so no try is spent;
    // the owed actions wait for the password like the poll does.
    if (err instanceof MailboxLoginRefusal) {
      log(`email.inbox-poll: on-arrival rule actions on ${account.address} wait: ${err.message}`);
      return [];
    }
    // No connection (or it broke between rules): every rule not yet tried owes one more try.
    for (const { policy, ids } of byPolicy.values()) {
      if (!settled.has(policy.id)) await failure(policy, ids, err);
    }
    return [];
  }
}
