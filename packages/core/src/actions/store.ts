/**
 * Creating and reading actions.
 *
 * An action and its `pending` approval are born together, in one statement:
 * there is no window in which an action exists with no state machine over it,
 * and no window in which a preview could be shown for something not yet
 * recorded. The action object is immutable from that moment; everything that
 * happens later is written to the approval row or the effect ledger.
 */
import type { Queryable } from '../owner.js';
import type { OwnerChoice } from '../tools.js';
import {
  DEFAULT_APPROVAL_TTL_MS,
  POLICY_VERSION,
  canonicalize,
  hashAction,
  toActionRecord,
  toAttemptRecord,
  validateDeclaredChoices,
  type ActionRecord,
  type ApprovalState,
  type EffectAttemptRecord,
} from './types.js';

/** Append to the core event log. Local so this module needs only `Queryable`. */
export async function emitActionEvent(
  pool: Queryable,
  kind: string,
  payload: unknown,
  conversationId?: string | null,
): Promise<void> {
  await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, $2, $3::jsonb)`,
    [kind, conversationId ?? null, JSON.stringify(payload ?? null)],
  );
}

export interface CreateActionInput {
  tool: string;
  /** The tool's plugin version. Part of the hash execution rechecks. */
  toolVersion: string;
  agentId: string;
  conversationId?: string | null;
  /** The job whose run suspends on this decision, when a job proposed it. */
  jobId?: string | null;
  /** Arguments as the registry validated them; canonicalized here. */
  canonicalArgs: unknown;
  /** What will actually happen, as the tool described it. */
  envelope: unknown;
  /** Rendered from the envelope by the tool, never from model-written text. */
  preview: string;
  /** What the tool offered the owner to decide. Part of the approved hash. */
  choices?: readonly OwnerChoice[];
  /** Defaults to 24 hours from `now`. */
  ttlMs?: number;
  expiresAt?: Date;
  policyVersion?: number;
  now?: Date;
}

/**
 * The columns every read returns: the action, plus its approval row. One query,
 * one shape, so nothing anywhere has to remember to join.
 */
const SELECT_ACTION = `
  select a.id, a.tool, a.tool_version, a.agent_id, a.conversation_id, a.job_id,
         a.canonical_args, a.envelope, a.choices, a.args_hash, a.preview, a.expires_at,
         a.policy_version, a.created_at,
         ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
         ap.claimed_by, ap.claimed_at, ap.owner_choices, ap.outcome, ap.updated_at
    from core.actions a
    join core.approvals ap on ap.action_id = a.id`;

export async function createAction(
  pool: Queryable,
  input: CreateActionInput,
): Promise<ActionRecord> {
  const now = input.now ?? new Date();
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS));
  const canonicalArgs = canonicalize(input.canonicalArgs);
  // Checked here, before anyone is asked: a menu whose default is not on it is
  // a menu the owner cannot be honestly shown.
  const choices = validateDeclaredChoices(input.choices ?? []);
  const argsHash = hashAction(input.tool, input.toolVersion, canonicalArgs, input.envelope, choices);

  const { rows } = await pool.query(
    `with a as (
       insert into core.actions
         (tool, tool_version, agent_id, conversation_id, job_id, canonical_args,
          envelope, args_hash, preview, expires_at, policy_version, created_at, choices)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb)
       returning *
     ), ap as (
       insert into core.approvals (action_id, state, updated_at)
       select a.id, 'pending', $12 from a
       returning *
     )
     select a.id, a.tool, a.tool_version, a.agent_id, a.conversation_id, a.job_id,
            a.canonical_args, a.envelope, a.choices, a.args_hash, a.preview, a.expires_at,
            a.policy_version, a.created_at,
            ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
            ap.claimed_by, ap.claimed_at, ap.owner_choices, ap.outcome, ap.updated_at
       from a, ap`,
    // $13 is the declared choice list; $12 is `now`, used by both inserts.
    [
      input.tool,
      input.toolVersion,
      input.agentId,
      input.conversationId ?? null,
      input.jobId ?? null,
      JSON.stringify(canonicalArgs ?? null),
      JSON.stringify(canonicalize(input.envelope) ?? null),
      argsHash,
      input.preview,
      expiresAt,
      input.policyVersion ?? POLICY_VERSION,
      now,
      JSON.stringify(choices),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('createAction: insert returned no row');
  const action = toActionRecord(row);

  await emitActionEvent(
    pool,
    'action.created',
    {
      actionId: action.id,
      tool: action.tool,
      toolVersion: action.toolVersion,
      agentId: action.agentId,
      jobId: action.jobId,
      argsHash: action.argsHash,
      expiresAt: action.expiresAt.toISOString(),
      policyVersion: action.policyVersion,
    },
    action.conversationId,
  );

  return action;
}

export async function getAction(
  pool: Queryable,
  actionId: string,
): Promise<ActionRecord | undefined> {
  const { rows } = await pool.query(`${SELECT_ACTION} where a.id = $1`, [actionId]);
  return rows[0] ? toActionRecord(rows[0]) : undefined;
}

export interface ListActionsOptions {
  state?: ApprovalState;
  /** Hide requests already past their expiry (they are not decidable). */
  now?: Date;
  limit?: number;
}

/**
 * Pending approvals, oldest first: the order the owner should see them in, and
 * the order `/approvals` lists them.
 */
export async function listPendingActions(
  pool: Queryable,
  opts: ListActionsOptions = {},
): Promise<ActionRecord[]> {
  const now = opts.now ?? new Date();
  const { rows } = await pool.query(
    `${SELECT_ACTION}
      where ap.state = $1 and a.expires_at > $2
      order by a.created_at asc
      limit $3`,
    [opts.state ?? 'pending', now, opts.limit ?? 50],
  );
  return rows.map(toActionRecord);
}

/**
 * Move every pending approval whose action has expired to `expired`.
 *
 * Expiry is a fact about the clock, so it is also checked on every decision and
 * on every claim; this sweep only makes it visible without a decision arriving.
 */
export async function expireDueApprovals(
  pool: Queryable,
  opts: { now?: Date } = {},
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const { rows } = await pool.query(
    `update core.approvals ap
        set state = 'expired', updated_at = $1
       from core.actions a
      where ap.action_id = a.id
        and ap.state = 'pending'
        and a.expires_at <= $1
      returning ap.action_id, a.conversation_id, a.tool`,
    [now],
  );
  for (const row of rows) {
    await emitActionEvent(
      pool,
      'approval.expired',
      { actionId: String(row.action_id), tool: row.tool },
      row.conversation_id,
    );
  }
  return rows.map((r) => String(r.action_id));
}

/** The ledger rows for one action, oldest attempt first. */
export async function listEffectAttempts(
  pool: Queryable,
  actionId: string,
): Promise<EffectAttemptRecord[]> {
  const { rows } = await pool.query(
    `select * from core.effect_attempts where action_id = $1 order by attempt asc`,
    [actionId],
  );
  return rows.map(toAttemptRecord);
}
