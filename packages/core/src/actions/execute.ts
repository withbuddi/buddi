/**
 * The Executor: the only path by which a gated tool ever runs.
 *
 * ARCHITECTURE.md, "Actions and approvals" and "Effectful side effects", make
 * the order non-negotiable, so it is spelled out here:
 *
 *   1. **Claim atomically.** One UPDATE moves `approved` to `executing` and
 *      stamps the claimer. Two workers racing on the same action produce one
 *      winner and one `already-claimed`; there is no lock held anywhere.
 *   2. **Recheck authorization.** Expiry is rechecked in the claim itself.
 *      The args hash is recomputed from the stored canonical arguments and
 *      compared with the one the owner approved: a tool upgraded (or a row
 *      edited) under a standing approval refuses instead of running.
 *   3. **Record intent before dispatch.** An `effect_attempts` row carrying the
 *      envelope hash is written *first*, so a crash mid-flight still leaves
 *      evidence that the effect may have happened.
 *   4. **Dispatch under a deadline.** A timeout is `unknown`: the attempt and
 *      the approval both say so, and nothing retries it automatically. Only
 *      the owner decides what an `unknown` means.
 *
 * There is deliberately no "execute this tool, trust me" entry point: the
 * registry refuses gated tools, and this function only ever runs one that an
 * approval row says was approved.
 */
import type { ToolContext } from '../tools.js';
import type { Queryable } from '../owner.js';
import { emitActionEvent } from './store.js';
import {
  DEFAULT_EFFECT_TIMEOUT_MS,
  hashArgs,
  hashEnvelope,
  toActionRecord,
  type ActionRecord,
  type ApprovalState,
} from './types.js';

/** What the Executor needs of a registered tool. `ToolRegistry` satisfies it. */
export interface ExecutableTool {
  name: string;
  /** The plugin version, part of the approved hash. */
  version: string;
  input: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  /** The tool's own deadline; `DEFAULT_EFFECT_TIMEOUT_MS` when it declares none. */
  timeoutMs?: number | undefined;
  execute(input: any, ctx: ToolContext): Promise<unknown>;
}

export interface ToolLookup {
  /** The registered tool, for the Executor only. */
  lookup(name: string): ExecutableTool | undefined;
}

export interface ExecuteApprovedInput {
  actionId: string;
  registry: ToolLookup;
  /** The tool context the effect runs with. Credentials live here, not in agents. */
  ctx: ToolContext;
  /** Who is executing: a worker id, recorded on the claim. */
  worker: string;
  now?: Date;
  /** Overrides the tool's own deadline. Tests use it; production rarely should. */
  timeoutMs?: number;
}

export type ExecuteApprovedResult =
  | { ok: true; state: 'succeeded'; action: ActionRecord; result: unknown; attempt: number }
  | {
      ok: false;
      state: ApprovalState;
      reason:
        | 'not-found'
        | 'not-approved'
        | 'expired'
        | 'already-claimed'
        | 'args-hash-mismatch'
        | 'unknown-tool'
        | 'invalid-args'
        | 'tool-error'
        | 'timeout';
      message: string;
      attempt?: number;
    };

export async function executeApproved(
  pool: Queryable,
  input: ExecuteApprovedInput,
): Promise<ExecuteApprovedResult> {
  const now = input.now ?? new Date();

  // 1. Claim: approved -> executing, expiry rechecked in the same statement.
  const { rows } = await pool.query(
    `update core.approvals ap
        set state = 'executing', claimed_by = $2, claimed_at = $3, updated_at = $3
       from core.actions a
      where ap.action_id = a.id
        and ap.action_id = $1
        and ap.state = 'approved'
        and a.expires_at > $3
      returning a.id, a.tool, a.tool_version, a.agent_id, a.conversation_id, a.job_id,
                a.canonical_args, a.envelope, a.args_hash, a.preview, a.expires_at,
                a.policy_version, a.created_at,
                ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
                ap.claimed_by, ap.claimed_at, ap.outcome, ap.updated_at`,
    [input.actionId, input.worker, now],
  );

  if (!rows[0]) return refuseClaim(pool, input.actionId, now);

  const action = toActionRecord(rows[0]);
  await emitActionEvent(
    pool,
    'approval.claimed',
    { actionId: action.id, tool: action.tool, worker: input.worker },
    action.conversationId,
  );

  // 2. Recheck what the owner actually approved.
  const recomputed = hashArgs(action.tool, action.toolVersion, action.canonicalArgs);
  if (recomputed !== action.argsHash) {
    return settleWithoutDispatch(pool, action, 'args-hash-mismatch', {
      message:
        'the approved arguments no longer hash to the approved value; this approval is void',
      expected: action.argsHash,
      actual: recomputed,
    });
  }

  const tool = input.registry.lookup(action.tool);
  if (!tool) {
    return settleWithoutDispatch(pool, action, 'unknown-tool', {
      message: `tool ${action.tool} is not registered in this build`,
    });
  }
  if (tool.version !== action.toolVersion) {
    return settleWithoutDispatch(pool, action, 'args-hash-mismatch', {
      message: `tool ${action.tool} is version ${tool.version}; the approval was bound to ${action.toolVersion}`,
    });
  }
  const parsed = tool.input.safeParse(action.canonicalArgs);
  if (!parsed.success) {
    return settleWithoutDispatch(pool, action, 'invalid-args', {
      message: `the approved arguments no longer validate against ${action.tool}`,
    });
  }

  // 3. Intent before dispatch: the ledger row exists before anything leaves.
  const attempt = await startAttempt(pool, action, now);

  // 4. Dispatch under a deadline.
  const deadline = input.timeoutMs ?? tool.timeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS;
  // The context a gated effect runs with is built from the *action*, not from
  // whatever the caller happened to be holding. `actionId` is the idempotency
  // key — this is the only place a tool can get one, and a tool that cannot
  // prove it has not already run refuses without it.
  const ctx: ToolContext = {
    ...input.ctx,
    actionId: action.id,
    ...(action.agentId ? { agentId: action.agentId } : {}),
    ...(action.conversationId ? { conversationId: action.conversationId } : {}),
    ...(action.jobId ? { jobId: action.jobId } : {}),
  };

  let outcome: { kind: 'ok'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'timeout' };
  try {
    outcome = await withDeadline(
      () => tool.execute(parsed.data, ctx),
      deadline,
    );
  } catch (err) {
    outcome = { kind: 'error', error: err };
  }

  if (outcome.kind === 'ok') {
    await finishAttempt(pool, attempt.id, 'succeeded', { result: outcome.value });
    const settled = await settleApproval(pool, action, 'succeeded', {
      attempt: attempt.attempt,
      result: outcome.value,
    });
    await emitActionEvent(
      pool,
      'effect.succeeded',
      { actionId: action.id, tool: action.tool, attempt: attempt.attempt },
      action.conversationId,
    );
    return { ok: true, state: 'succeeded', action: settled, result: outcome.value, attempt: attempt.attempt };
  }

  if (outcome.kind === 'timeout') {
    // Ambiguous completion. The effect may have happened; v1 requires a human
    // to look, and nothing here retries.
    const message = `${action.tool} did not answer within ${deadline}ms; the effect may or may not have happened`;
    await finishAttempt(pool, attempt.id, 'unknown', { error: message });
    await settleApproval(pool, action, 'unknown', { attempt: attempt.attempt, reason: 'timeout', error: message });
    await emitActionEvent(
      pool,
      'effect.unknown',
      { actionId: action.id, tool: action.tool, attempt: attempt.attempt, timeoutMs: deadline },
      action.conversationId,
    );
    return { ok: false, state: 'unknown', reason: 'timeout', message, attempt: attempt.attempt };
  }

  const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  await finishAttempt(pool, attempt.id, 'failed', { error: message });
  await settleApproval(pool, action, 'failed', { attempt: attempt.attempt, reason: 'tool-error', error: message });
  await emitActionEvent(
    pool,
    'effect.failed',
    { actionId: action.id, tool: action.tool, attempt: attempt.attempt, error: message },
    action.conversationId,
  );
  return { ok: false, state: 'failed', reason: 'tool-error', message, attempt: attempt.attempt };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Why the claim found nothing: not there, not approved, expired, or taken. */
async function refuseClaim(
  pool: Queryable,
  actionId: string,
  now: Date,
): Promise<ExecuteApprovedResult> {
  const { rows } = await pool.query(
    `select ap.state, a.expires_at, ap.claimed_by
       from core.approvals ap join core.actions a on a.id = ap.action_id
      where ap.action_id = $1`,
    [actionId],
  );
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      state: 'unknown',
      reason: 'not-found',
      message: `no such action: ${actionId}`,
    };
  }
  const state = row.state as ApprovalState;
  if (state === 'approved' && new Date(row.expires_at) <= now) {
    await pool.query(
      `update core.approvals set state = 'expired', updated_at = $2 where action_id = $1 and state = 'approved'`,
      [actionId, now],
    );
    await emitActionEvent(pool, 'approval.expired', { actionId }, null);
    return {
      ok: false,
      state: 'expired',
      reason: 'expired',
      message: 'the approval expired before it was executed',
    };
  }
  if (state === 'executing' || state === 'succeeded' || state === 'failed') {
    return {
      ok: false,
      state,
      reason: 'already-claimed',
      message: `this action is already ${state}${row.claimed_by ? ` (claimed by ${row.claimed_by})` : ''}`,
    };
  }
  return {
    ok: false,
    state,
    reason: 'not-approved',
    message: `this action is ${state}, not approved`,
  };
}

/**
 * A refusal discovered *after* the claim but *before* dispatch. No effect
 * attempt is recorded, because nothing was attempted; the approval lands in
 * `failed` carrying the reason, and never goes back to `approved`.
 */
async function settleWithoutDispatch(
  pool: Queryable,
  action: ActionRecord,
  reason: 'args-hash-mismatch' | 'unknown-tool' | 'invalid-args',
  detail: Record<string, unknown> & { message: string },
): Promise<ExecuteApprovedResult> {
  await settleApproval(pool, action, 'failed', { reason, ...detail });
  await emitActionEvent(
    pool,
    'effect.refused',
    { actionId: action.id, tool: action.tool, reason, message: detail.message },
    action.conversationId,
  );
  return { ok: false, state: 'failed', reason, message: detail.message };
}

async function startAttempt(
  pool: Queryable,
  action: ActionRecord,
  now: Date,
): Promise<{ id: string; attempt: number }> {
  const envelopeHash = hashEnvelope(action.envelope);
  const { rows } = await pool.query(
    `insert into core.effect_attempts (action_id, attempt, started_at, state, envelope_hash)
     select $1, coalesce(max(attempt), 0) + 1, $2, 'executing', $3
       from core.effect_attempts where action_id = $1
     returning id, attempt`,
    [action.id, now, envelopeHash],
  );
  const row = rows[0];
  if (!row) throw new Error('executeApproved: could not open an effect attempt');
  await emitActionEvent(
    pool,
    'effect.attempted',
    {
      actionId: action.id,
      tool: action.tool,
      attempt: Number(row.attempt),
      envelopeHash,
    },
    action.conversationId,
  );
  return { id: String(row.id), attempt: Number(row.attempt) };
}

async function finishAttempt(
  pool: Queryable,
  attemptId: string,
  state: 'succeeded' | 'failed' | 'unknown',
  detail: { result?: unknown; error?: string },
): Promise<void> {
  await pool.query(
    `update core.effect_attempts
        set state = $2, finished_at = now(), result = $3::jsonb, error = $4
      where id = $1`,
    [
      attemptId,
      state,
      detail.result === undefined ? null : JSON.stringify(detail.result),
      detail.error ?? null,
    ],
  );
}

async function settleApproval(
  pool: Queryable,
  action: ActionRecord,
  state: 'succeeded' | 'failed' | 'unknown',
  outcome: Record<string, unknown>,
): Promise<ActionRecord> {
  const { rows } = await pool.query(
    `update core.approvals
        set state = $2, outcome = $3::jsonb, updated_at = now()
      where action_id = $1
      returning state`,
    [action.id, state, JSON.stringify(outcome)],
  );
  const settledState = (rows[0]?.state as ApprovalState) ?? state;
  return { ...action, state: settledState, outcome };
}

/** Race the effect against its deadline. A late answer is dropped, not thrown. */
async function withDeadline<T>(
  run: () => Promise<T>,
  ms: number,
): Promise<{ kind: 'ok'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const work = run().then(
    (value) => ({ kind: 'ok', value }) as const,
    (error) => ({ kind: 'error', error }) as const,
  );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // The effect may still be in flight: whatever it does, it must not become
    // an unhandled rejection after the deadline decided the outcome.
    void work.catch(() => {});
  }
}
