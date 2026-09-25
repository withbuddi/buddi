/**
 * The decision: `pending` becomes `approved` or `rejected`, once.
 *
 * The transition is one atomic UPDATE guarded on the current state and on the
 * action's expiry, so:
 *
 *  - a second tap on an inline keyboard changes nothing and says so;
 *  - two paired surfaces racing on the same action resolve *one* decision, and
 *    the loser is told which way it went (docs/architecture.md, "Owner and
 *    surface authentication": resolution from any paired surface races on the same atomic
 *    state transition);
 *  - a decision arriving after expiry does not revive the action. The row is
 *    moved to `expired` instead, and the caller sees `expired`, not `approved`.
 *
 * Who decided and from where are recorded on the row, because "the owner
 * approved this" is the fact the whole boundary rests on.
 */
import type { Queryable } from '../owner.js';
import { emitActionEvent } from './store.js';
import {
  resolveOwnerChoices,
  toActionRecord,
  type ActionRecord,
  type ApprovalState,
} from './types.js';
import { getAction } from './store.js';
import type { ToolLookup } from './execute.js';
import type { PermissionScope } from './permissions.js';

export type Decision = 'approved' | 'rejected';

export interface DecideApprovalInput {
  actionId: string;
  decision: Decision;
  /** The owner identity that decided. Never an agent, never a model. */
  by: string;
  /** The surface the decision arrived on: 'telegram', 'cli', 'web'. */
  via: string;
  now?: Date;
  permissionScope?: PermissionScope;
  registry?: ToolLookup;
  /**
   * What the owner picked among the choices the action declared, by key.
   *
   * Validated here against the declared list — not by the surface that
   * collected it — so "the owner can only pick among options the envelope
   * itself listed" is one rule in one place, whatever surface the tap came
   * from. Keys the owner left out take their declared default.
   */
  ownerChoices?: Record<string, unknown>;
}

export type DecideApprovalResult =
  | { ok: true; action: ActionRecord }
  | {
      ok: false;
      reason: 'not-found' | 'expired' | 'already-decided' | 'invalid-permission' | 'invalid-choice';
      /** The state the approval is actually in, when there is a row. */
      state?: ApprovalState;
      message: string;
    };

export async function decideApproval(
  pool: Queryable,
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  const now = input.now ?? new Date();

  /*
   * The owner's choices, resolved before anything moves.
   *
   * Read from the *stored* action, never from what the surface sent: the
   * declared menu is part of the action object the hash binds, so validating
   * against it is validating against what the owner was actually shown. An
   * approval with no declared choices resolves to `{}` and this costs one
   * extra read; a rejection is never a choice about anything and skips it.
   */
  let ownerChoices: Record<string, string> = {};
  if (input.decision === 'approved') {
    const declared = await getAction(pool, input.actionId);
    if (declared) {
      try {
        ownerChoices = resolveOwnerChoices(declared.choices, input.ownerChoices);
      } catch (err) {
        return {
          ok: false,
          reason: 'invalid-choice',
          state: declared.state,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } else if (input.ownerChoices && Object.keys(input.ownerChoices).length > 0) {
    // Rejecting *and* choosing is incoherent enough to be a bug in the caller.
    return {
      ok: false,
      reason: 'invalid-choice',
      message: 'a rejection carries no choices',
    };
  }

  const remember = input.permissionScope && input.permissionScope !== 'once';
  if (remember) {
    const action = await getAction(pool, input.actionId);
    const tool = action && input.registry?.lookup(action.tool);
    if (input.decision !== 'approved' || !action || !tool?.reusableApproval ||
        tool.version !== action.toolVersion || !action.conversationId ||
        !['conversation', 'always'].includes(input.permissionScope!)) {
      return { ok: false, reason: 'invalid-permission', message: 'This action does not support that permission scope.' };
    }
  }

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
    `${remember ? 'with decided as (' : ''}update core.approvals ap
        set state = $2, decided_by = $3, decided_via = $4, decided_at = $5, updated_at = $5,
            owner_choices = $6::jsonb
       from core.actions a
      where ap.action_id = a.id
        and ap.action_id = $1
        and ap.state = 'pending'
        and a.expires_at > $5
      returning a.id, a.tool, a.tool_version, a.agent_id, a.conversation_id, a.job_id,
                a.canonical_args, a.envelope, a.choices, a.tier, a.args_hash, a.preview, a.expires_at,
                a.policy_version, a.created_at,
                ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
                ap.claimed_by, ap.claimed_at, ap.owner_choices, ap.outcome, ap.updated_at${remember ? `
      ), remembered as (
        insert into core.tool_permissions (owner_id, agent_id, tool, tool_version, conversation_id, granted_via)
        select $3, agent_id, tool, tool_version, case when $7 = 'always' then '' else conversation_id::text end, $4 from decided
        on conflict (owner_id, agent_id, tool, tool_version, conversation_id)
        do update set granted_via=excluded.granted_via
      ) select * from decided` : ''}`,
    [
      input.actionId,
      input.decision,
      input.by,
      input.via,
      now,
      input.decision === 'approved' ? JSON.stringify(ownerChoices) : null,
      ...(remember ? [input.permissionScope] : []),
    ],
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
        permissionScope: input.permissionScope ?? 'once',
        ...(Object.keys(ownerChoices).length > 0 ? { ownerChoices } : {}),
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
