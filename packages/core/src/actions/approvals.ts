/**
 * The decision: `pending` becomes `approved` or `rejected`, once.
 *
 * The transition is one atomic UPDATE guarded on the current state and on the
 * action's expiry, so:
 *
 *  - a second tap on an inline keyboard changes nothing and says so;
 *  - two paired surfaces racing on the same action resolve *one* decision, and
 *    the loser is told which way it went (ARCHITECTURE.md, "Approval callbacks
 *    are bound": resolution from any paired surface races on the same atomic
 *    state transition);
 *  - a decision arriving after expiry does not revive the action. The row is
 *    moved to `expired` instead, and the caller sees `expired`, not `approved`.
 *
 * Who decided and from where are recorded on the row, because "the owner
 * approved this" is the fact the whole boundary rests on.
 */
import type { Queryable } from '../owner.js';
import { emitActionEvent } from './store.js';
import { toActionRecord, type ActionRecord, type ApprovalState } from './types.js';

export type Decision = 'approved' | 'rejected';

export interface DecideApprovalInput {
  actionId: string;
  decision: Decision;
  /** The owner identity that decided. Never an agent, never a model. */
  by: string;
  /** The surface the decision arrived on: 'telegram', 'cli', 'web'. */
  via: string;
  now?: Date;
}

export type DecideApprovalResult =
  | { ok: true; action: ActionRecord }
  | {
      ok: false;
      reason: 'not-found' | 'expired' | 'already-decided';
      /** The state the approval is actually in, when there is a row. */
      state?: ApprovalState;
      message: string;
    };

export async function decideApproval(
  pool: Queryable,
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  const now = input.now ?? new Date();

  // An expired request is moved to `expired` before anything else looks at it,
  // so "decide" and "expire" cannot both claim the same pending row.
  await pool.query(
    `update core.approvals ap
        set state = 'expired', updated_at = $2
       from core.actions a
      where ap.action_id = a.id
        and ap.action_id = $1
        and ap.state = 'pending'
        and a.expires_at <= $2`,
    [input.actionId, now],
  );

  const { rows } = await pool.query(
    `update core.approvals ap
        set state = $2, decided_by = $3, decided_via = $4, decided_at = $5, updated_at = $5
       from core.actions a
      where ap.action_id = a.id
        and ap.action_id = $1
        and ap.state = 'pending'
        and a.expires_at > $5
      returning a.id, a.tool, a.tool_version, a.agent_id, a.conversation_id, a.job_id,
                a.canonical_args, a.envelope, a.args_hash, a.preview, a.expires_at,
                a.policy_version, a.created_at,
                ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
                ap.claimed_by, ap.claimed_at, ap.outcome, ap.updated_at`,
    [input.actionId, input.decision, input.by, input.via, now],
  );

  if (rows[0]) {
    const action = toActionRecord(rows[0]);
    await emitActionEvent(
      pool,
      'approval.decided',
      {
        actionId: action.id,
        tool: action.tool,
        decision: input.decision,
        decidedBy: input.by,
        decidedVia: input.via,
        jobId: action.jobId,
      },
      action.conversationId,
    );
    return { ok: true, action };
  }

  // Nothing moved: say precisely why, because the surface has to answer.
  const { rows: current } = await pool.query(
    `select ap.state from core.approvals ap where ap.action_id = $1`,
    [input.actionId],
  );
  const state = current[0]?.state as ApprovalState | undefined;
  if (state === undefined) {
    return {
      ok: false,
      reason: 'not-found',
      message: `no such action: ${input.actionId}`,
    };
  }
  if (state === 'expired') {
    return {
      ok: false,
      reason: 'expired',
      state,
      message: 'this request expired before it was decided',
    };
  }
  return {
    ok: false,
    reason: 'already-decided',
    state,
    message: `this request is already ${state}`,
  };
}
