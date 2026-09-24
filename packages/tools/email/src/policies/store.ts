/**
 * Reading and writing policies and the gate's events.
 *
 * Everything with SQL in it lives here, so `gate.ts` can stay a pure function
 * and `learn.ts` can stay a pure rule. Nothing in this file decides anything.
 */
import type { DbArea } from '@buddi/core/plugin';
import { normalizeAddress, normalizeListId } from '../mail.js';
import {
  domainOf,
  isUnimplementedAction,
  POLICY_ACTIONS,
  POLICY_ORIGINS,
  POLICY_SCOPES,
  type PolicyAction,
  type PolicyOrigin,
  type PolicyParams,
  type PolicyRecord,
  type PolicyScope,
} from './gate.js';

/** `ctx.buddi.db`, a transaction's handle, or anything that answers a query as they do. */
type Db = Pick<DbArea, 'query'>;

export const POLICY_COLUMNS =
  'id, account_id, scope, matcher, action, params, origin, proposed, created_from, created_at, revoked_at, kept_at';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toPolicy(row: Record<string, any>): PolicyRecord {
  return {
    id: String(row.id),
    accountId: row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
    scope: row.scope as PolicyScope,
    matcher: row.matcher,
    action: row.action as PolicyAction,
    params: (row.params ?? {}) as PolicyParams,
    origin: row.origin as PolicyOrigin,
    proposed: Boolean(row.proposed),
    createdFrom: Array.isArray(row.created_from) ? row.created_from : [],
    createdAt: iso(row.created_at),
    revokedAt: iso(row.revoked_at),
    keptAt: iso(row.kept_at),
  };
}

/**
 * The matcher, as it is stored: lowercased, and reduced to the thing the scope
 * actually compares. `@example.com` and `Example.com` are one domain;
 * `Jane <jane@x.test>` is one sender.
 */
export function normalizeMatcher(scope: PolicyScope, raw: string): string {
  const value = (raw ?? '').trim();
  switch (scope) {
    case 'sender': {
      const address = normalizeAddress(value);
      return address;
    }
    case 'domain': {
      const stripped = value.replace(/^@/, '').trim().toLowerCase();
      // `someone@example.com` given as a domain means `example.com`.
      return stripped.includes('@') ? domainOf(stripped) : stripped;
    }
    case 'list-id':
      return normalizeListId(value) ?? '';
    case 'thread':
      // The thread's row id (migration 007). Lowercased so the uuid a caller
      // typed in capitals is the uuid the gate compares.
      return value.toLowerCase();
  }
}

/**
 * Why a policy cannot be created, in one owner-facing line, or null.
 *
 * Validation, then refusal: `archive` and `label` are valid vocabulary with no
 * implementation behind them, and the honest answer is "not yet" at the moment
 * somebody asks for one — not a policy that silently never fires.
 */
export function refusalFor(input: {
  scope: PolicyScope;
  matcher: string;
  action: PolicyAction;
  params?: PolicyParams;
}): string | null {
  if (!POLICY_SCOPES.includes(input.scope)) return `unknown scope: ${input.scope}`;
  if (!POLICY_ACTIONS.includes(input.action)) return `unknown action: ${input.action}`;
  const matcher = normalizeMatcher(input.scope, input.matcher);
  if (matcher === '') return `that is not a ${input.scope} to match on`;
  if (input.scope === 'sender' && !matcher.includes('@')) return 'a sender policy needs an address';
  if (input.scope === 'domain' && !matcher.includes('.')) return 'a domain policy needs a domain';
  if (isUnimplementedAction(input.action)) {
    return `not yet: "${input.action}" needs to write to the mailbox over IMAP, and this build only ever reads it. Ignore, notify, draft, hand-to-agent and wake work today.`;
  }
  if (input.action === 'hand-to-agent' && !input.params?.agentId?.trim()) {
    return 'hand-to-agent needs the id of the agent that should get the message';
  }
  return null;
}

export class PolicyRefusal extends Error {
  override readonly name = 'PolicyRefusal';
}

export interface CreatePolicyInput {
  accountId?: string | null;
  scope: PolicyScope;
  matcher: string;
  action: PolicyAction;
  params?: PolicyParams;
  origin: PolicyOrigin;
  proposed?: boolean;
  createdFrom?: Array<{ messageId: string; processingVersion: number }>;
  /** The owner kept this from Settings → Proposals: it is stamped kept at `now`. */
  kept?: boolean;
}

/**
 * Write one policy, replacing whatever live one held the same slot.
 *
 * Replacing rather than erroring is the right shape for a decision: the owner
 * saying "ignore this sender" about a sender they already said "notify me
 * about" is a *new* decision, not a conflict, and the old row stays as a
 * revoked record of what they used to think.
 */
export async function createPolicy(
  db: Db,
  input: CreatePolicyInput,
  now: Date,
): Promise<PolicyRecord> {
  const refusal = refusalFor(input);
  if (refusal) throw new PolicyRefusal(refusal);
  const matcher = normalizeMatcher(input.scope, input.matcher);
  const accountId = input.accountId ?? null;

  await db.query(
    `update email.policies set revoked_at = $1
      where revoked_at is null and scope = $2 and matcher = $3
        and coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [now, input.scope, matcher, accountId],
  );

  const { rows } = await db.query(
    `insert into email.policies
       (account_id, scope, matcher, action, params, origin, proposed, created_from, created_at, kept_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10)
     returning ${POLICY_COLUMNS}`,
    [
      accountId,
      input.scope,
      matcher,
      input.action,
      JSON.stringify(input.params ?? {}),
      input.origin,
      input.proposed ?? false,
      JSON.stringify(input.createdFrom ?? []),
      now,
      input.kept === true ? now : null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('createPolicy: insert returned no row');
  return toPolicy(row);
}

/** Every live policy the gate may consider, newest first. Proposals included. */
export async function loadPolicies(db: Db, accountId?: string | null): Promise<PolicyRecord[]> {
  const { rows } = await db.query(
    `select ${POLICY_COLUMNS} from email.policies
      where revoked_at is null
        and ($1::uuid is null or account_id is null or account_id = $1::uuid)
      order by created_at desc, id desc`,
    [accountId ?? null],
  );
  return rows.map(toPolicy);
}

export async function findPolicy(db: Db, id: string): Promise<PolicyRecord | null> {
  const { rows } = await db.query(`select ${POLICY_COLUMNS} from email.policies where id = $1`, [id]);
  return rows[0] ? toPolicy(rows[0]) : null;
}

/** The live policy for one sender address, or null. */
export async function policyForSender(
  db: Db,
  address: string,
  accountId?: string | null,
): Promise<PolicyRecord | null> {
  const matcher = normalizeMatcher('sender', address);
  if (matcher === '') return null;
  const { rows } = await db.query(
    `select ${POLICY_COLUMNS} from email.policies
      where revoked_at is null and scope = 'sender' and matcher = $1
        and ($2::uuid is null or account_id is null or account_id = $2::uuid)
      order by created_at desc, id desc limit 1`,
    [matcher, accountId ?? null],
  );
  return rows[0] ? toPolicy(rows[0]) : null;
}

/** Keep a proposal: it stops being a suggestion and starts deciding. */
export async function keepPolicy(db: Db, id: string): Promise<PolicyRecord | null> {
  const { rows } = await db.query(
    `update email.policies set proposed = false
      where id = $1 and revoked_at is null returning ${POLICY_COLUMNS}`,
    [id],
  );
  return rows[0] ? toPolicy(rows[0]) : null;
}

/** Revoke. The row stays; its effect does not. Revoking twice is a no-op. */
export async function revokePolicy(db: Db, id: string, now: Date): Promise<PolicyRecord | null> {
  const { rows } = await db.query(
    `update email.policies set revoked_at = coalesce(revoked_at, $2)
      where id = $1 returning ${POLICY_COLUMNS}`,
    [id, now],
  );
  return rows[0] ? toPolicy(rows[0]) : null;
}

/** What one bulk keep or revoke did. Counts, because the page shows counts. */
export interface BulkPolicyResult {
  /** Proposals that are now deciding. Zero for a revoke. */
  kept: number;
  /** Rules that now decide nothing. Zero for a keep. */
  revoked: number;
  /** Ids that matched no row this action could touch. */
  missing: number;
}

/**
 * Keep or revoke exactly the policies named, in one transaction.
 *
 * One statement per call rather than a loop of `keepPolicy`/`revokePolicy`:
 * the owner ticking seventy-three proposals and tapping "Keep selected" made
 * *one* decision, and half of it landing because the connection dropped in the
 * middle would leave an installation nobody chose — some senders deciding,
 * some still proposing, and no way to tell which tick failed.
 *
 * `missing` is the honest remainder: ids that named no row this action could
 * touch, because the list the page was holding is older than the database.
 * A keep only ever touches a live row; a revoke is idempotent, so revoking
 * something already revoked counts as revoked rather than missing.
 */
export async function bulkPolicies(
  pool: DbArea,
  action: 'keep' | 'revoke',
  ids: readonly string[],
  now: Date,
): Promise<BulkPolicyResult> {
  const unique = [...new Set(ids.map((id) => String(id ?? '').trim()).filter((id) => id !== ''))];
  if (unique.length === 0) return { kept: 0, revoked: 0, missing: 0 };

  const touched = await pool.transaction(async (client) => {
    const { rows } =
      action === 'keep'
        ? await client.query(
            `update email.policies set proposed = false
              where id = any($1::uuid[]) and revoked_at is null
              returning id`,
            [unique],
          )
        : await client.query(
            `update email.policies set revoked_at = coalesce(revoked_at, $2)
              where id = any($1::uuid[])
              returning id`,
            [unique, now],
          );
    return rows.length;
  });
  return {
    kept: action === 'keep' ? touched : 0,
    revoked: action === 'revoke' ? touched : 0,
    missing: unique.length - touched,
  };
}

/**
 * How far the gate got with this message.
 *
 * An event is a claim about what happened, so it may not be written before the
 * thing it claims has happened:
 *
 *  - `done` — the action was carried out. For `ignore` that is the triage row
 *    and the stamp, written in the same transaction as the event itself, so
 *    either all three are there or none is.
 *  - `pending` — a run is being enqueued. Written first on purpose: the
 *    enqueue is another component's, outside this transaction, and a crash
 *    mid-enqueue must leave a row that says "we were in the middle of this"
 *    rather than one that says the message was handled.
 *  - `failed` — the enqueue threw. The message stays unstamped, so the next
 *    poll tries again; the row is *updated*, never added to, so a retry never
 *    turns one message into two events.
 */
export const EVENT_STATUSES = ['pending', 'done', 'failed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface GateEvent {
  id: string;
  messageId: string;
  policyId: string | null;
  action: string;
  detail: string;
  status: EventStatus;
  at: string | null;
}

export const EVENT_COLUMNS = 'id, message_id, policy_id, action, detail, status, at';

export function toEvent(row: Record<string, any>): GateEvent {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    policyId: row.policy_id === null || row.policy_id === undefined ? null : String(row.policy_id),
    action: row.action,
    detail: row.detail ?? '',
    status: (row.status ?? 'done') as EventStatus,
    at: iso(row.at),
  };
}

/**
 * Record what the gate did. One row per *message*, including `none`.
 *
 * Upsert rather than insert: a message the poll picks up again because it was
 * never stamped is the same decision being made again, not a second decision,
 * and an audit log that grows a row per retry is one nobody can count from.
 */
export async function recordEvent(
  db: Db,
  input: {
    messageId: string;
    policyId: string | null;
    action: string;
    detail: string;
    status?: EventStatus;
  },
  now: Date,
): Promise<GateEvent> {
  const { rows } = await db.query(
    `insert into email.events (message_id, policy_id, action, detail, status, at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (message_id) do update
       set policy_id = excluded.policy_id,
           action = excluded.action,
           detail = excluded.detail,
           status = excluded.status,
           at = excluded.at
     returning ${EVENT_COLUMNS}`,
    [input.messageId, input.policyId, input.action, input.detail, input.status ?? 'done', now],
  );
  const row = rows[0];
  if (!row) throw new Error('recordEvent: insert returned no row');
  return toEvent(row);
}

/** Close an event the enqueue has now finished with, one way or the other. */
export async function settleEvent(
  db: Db,
  messageId: string,
  status: EventStatus,
  detail?: string,
): Promise<void> {
  await db.query(
    `update email.events
        set status = $2,
            detail = coalesce($3, detail)
      where message_id = $1`,
    [messageId, status, detail ?? null],
  );
}

/**
 * How many runs each policy has saved, and when it last decided anything.
 *
 * "Saved" is counted honestly: only `ignore` skips a model run outright. The
 * other actions still start one, and claiming otherwise on the settings page
 * would be the plugin flattering itself.
 */
export async function policyStats(
  db: Db,
): Promise<Map<string, { runsSaved: number; decisions: number; lastAt: string | null }>> {
  const { rows } = await db.query(
    `select policy_id,
            count(*) filter (where action = 'ignore' and status = 'done')::int as runs_saved,
            count(*)::int as decisions,
            max(at) as last_at
       from email.events
      where policy_id is not null
      group by policy_id`,
  );
  const out = new Map<string, { runsSaved: number; decisions: number; lastAt: string | null }>();
  for (const row of rows) {
    out.set(String(row.policy_id), {
      runsSaved: Number(row.runs_saved ?? 0),
      decisions: Number(row.decisions ?? 0),
      lastAt: iso(row.last_at),
    });
  }
  return out;
}

/** Run the migration's backfill again. Idempotent; returns how many it wrote. */
export async function seedLearnedIgnorePolicies(db: Db, now?: Date): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select email.seed_learned_ignore_policies($1) as n`,
    [now ?? new Date()],
  );
  return Number(rows[0]?.n ?? 0);
}
