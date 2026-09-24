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
import type { CoreToolContext, EffectDescription } from '../tools.js';
import type { Queryable } from '../owner.js';
import { emitActionEvent } from './store.js';
import {
  DEFAULT_EFFECT_TIMEOUT_MS,
  hashAction,
  hashEnvelope,
  POLICY_VERSION,
  resolveOwnerChoices,
  toActionRecord,
  type ActionRecord,
  type ApprovalState,
} from './types.js';

/** What the Executor needs of a registered tool. `ToolRegistry` satisfies it. */
export interface ExecutableTool {
  /** The tool saves files and names them in its output; see ToolDefinition. */
  producesArtifacts?: boolean;
  reusableApproval?: boolean;
  name: string;
  /** The plugin version, part of the approved hash. */
  version: string;
  input: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  /** The tool's own deadline; `DEFAULT_EFFECT_TIMEOUT_MS` when it declares none. */
  timeoutMs?: number | undefined;
  execute(input: any, ctx: CoreToolContext): Promise<unknown>;
  describe?(input: any, ctx: CoreToolContext): EffectDescription | Promise<EffectDescription>;
  /**
   * Take exclusive hold of whatever this effect is about, immediately before
   * the ledger row is written — the last moment at which "nothing has
   * happened" is still true.
   *
   * It exists because `describe` cannot close a race it does not hold a lock
   * over: between the executor's re-description and the tool's own first write
   * there is a window in which the owner can edit the row the envelope was
   * built from, and a check that read the row a moment earlier would send the
   * old text. A tool whose subject can be edited by anyone else does its guard
   * here, as one conditional statement, and throws when it matches nothing.
   *
   * A throw settles the approval `refused` and writes **no effect attempt**,
   * which is the honest record: the claim is what decides whether anything is
   * attempted at all, so a claim that failed means nothing was.
   */
  claim?(input: any, ctx: CoreToolContext): Promise<void>;
}

export interface ToolLookup {
  /** The registered tool, for the Executor only. */
  lookup(name: string): ExecutableTool | undefined;
}

export interface ExecuteApprovedInput {
  actionId: string;
  registry: ToolLookup;
  /** The tool context the effect runs with. Credentials live here, not in agents. */
  ctx: CoreToolContext;
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
        | 'effect-changed'
        | 'policy-version-mismatch'
        | 'tier-not-executable'
        | 'unknown-tool'
        | 'invalid-args'
        | 'tool-error'
        | 'timeout'
        | 'cancelled';
      message: string;
      attempt?: number;
    };

export async function executeApproved(
  pool: Queryable,
  input: ExecuteApprovedInput,
): Promise<ExecuteApprovedResult> {
  input.ctx.signal?.throwIfAborted();
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
                a.canonical_args, a.envelope, a.choices, a.tier, a.args_hash, a.preview, a.expires_at,
                a.policy_version, a.created_at,
                ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
                ap.claimed_by, ap.claimed_at, ap.owner_choices, ap.outcome, ap.updated_at`,
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
  if (action.policyVersion !== POLICY_VERSION) {
    return settleWithoutDispatch(pool, action, 'policy-version-mismatch', {
      message: 'this approval predates full effect binding; propose the action again',
    });
  }
  /*
   * The tier the action was recorded under.
   *
   * Only `gated` ever produces an action, so anything else here is a defect
   * upstream — a row written by hand, or a future tier that learned to record
   * one. It settles without dispatch, because the whole promise of this path
   * is that it runs only what an owner was asked about.
   */
  if (action.tier !== null && action.tier !== 'gated') {
    return settleWithoutDispatch(pool, action, 'tier-not-executable', {
      message: `this action was recorded under tier '${action.tier}'; only a gated call is executed from an approval`,
    });
  }
  const recomputed = hashAction(
    action.tool,
    action.toolVersion,
    action.canonicalArgs,
    action.envelope,
    action.choices,
    action.tier,
  );
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

  // The context a gated effect runs with is built from the *action*, not from
  // whatever the caller happened to be holding. `actionId` is the idempotency
  // key — this is the only place a tool can get one, and a tool that cannot
  // prove it has not already run refuses without it.
  // What the owner picked, already validated against the declared menu at
  // decision time. An action decided before choices existed, or by a surface
  // that never asked, resolves every key to its declared default here, so a
  // tool reading `ctx.choices` never has to tell the two cases apart.
  //
  // Guarded, although the args hash above already covers a swapped menu: the
  // approval is claimed into `executing` by now, and an unguarded throw here
  // would strand it there for good rather than settling it.
  let ownerChoices: Readonly<Record<string, string>>;
  try {
    ownerChoices = Object.freeze(resolveOwnerChoices(action.choices, action.ownerChoices ?? {}));
  } catch (err) {
    return settleWithoutDispatch(pool, action, 'effect-changed', {
      message: `the recorded choices no longer match what was offered: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const ctx: CoreToolContext = {
    ...input.ctx,
    actionId: action.id,
    approvedEffect: { envelope: structuredClone(action.envelope) },
    choices: ownerChoices,
    ...(action.agentId ? { agentId: action.agentId } : {}),
    ...(action.conversationId ? { conversationId: action.conversationId } : {}),
    ...(action.jobId ? { jobId: action.jobId } : {}),
  };

  if (action.decidedVia?.startsWith('permission:')) {
    const { rows } = await pool.query(`select id from core.tool_permissions where id=$1
      and owner_id=$2 and agent_id=$3 and tool=$4 and tool_version=$5
      and conversation_id in ('', $6)`, [action.decidedVia.slice('permission:'.length),
      ctx.ownerId, action.agentId, action.tool, action.toolVersion, action.conversationId]);
    if (!tool.reusableApproval || !rows.length) return settleWithoutDispatch(pool, action, 'effect-changed', {
      message: 'The standing permission was revoked; request approval again.',
    });
  }

  // Resolve references again before creating an effect attempt. Freeze the
  // description clock at creation: derived preview dates must not drift just
  // because the owner took time to answer (for example a schedule's next runs).
  try {
    ctx.signal?.throwIfAborted();
    const current = tool.describe
      ? (await tool.describe(parsed.data, { ...ctx, now: () => action.createdAt })).envelope
      : parsed.data;
    if (hashEnvelope(current) !== hashEnvelope(action.envelope)) {
      return settleWithoutDispatch(pool, action, 'effect-changed', {
        message: 'the effect changed since its preview; propose the action again',
      });
    }
    ctx.signal?.throwIfAborted();
  } catch (err) {
    return settleWithoutDispatch(pool, action, 'effect-changed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  /*
   * The tool's own claim, if it has one — after the re-description and before
   * the ledger row, because a lost claim means nothing was attempted and must
   * not leave an attempt behind saying otherwise.
   */
  if (tool.claim) {
    try {
      ctx.signal?.throwIfAborted();
      await tool.claim(parsed.data, ctx);
    } catch (err) {
      return settleWithoutDispatch(pool, action, 'effect-changed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Intent before dispatch: the ledger row exists before anything leaves.
  const attempt = await startAttempt(pool, action, now);
  // 4. Signal a cooperative stop at the deadline. Completion remains unknown:
  // cancellation cannot retract an operation already dispatched externally.
  const deadline = input.timeoutMs ?? tool.timeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS;
  const controller = new AbortController();
  ctx.signal = input.ctx.signal
    ? AbortSignal.any([input.ctx.signal, controller.signal])
    : controller.signal;

  let outcome: { kind: 'ok'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'timeout' } | { kind: 'cancelled' };
  try {
    outcome = await withDeadline(
      () => {
        ctx.signal?.throwIfAborted();
        return tool.execute(parsed.data, ctx);
      },
      deadline,
      controller,
      ctx.signal,
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

  if (outcome.kind === 'timeout' || outcome.kind === 'cancelled' || ctx.signal.aborted) {
    // Ambiguous completion. The effect may have happened; v1 requires a human
    // to look, and nothing here retries.
    const message = outcome.kind === 'timeout'
      ? `${action.tool} did not answer within ${deadline}ms; the effect may or may not have happened`
      : `${action.tool} was cancelled during dispatch; the effect may or may not have happened`;
    const reason = outcome.kind === 'timeout' ? 'timeout' : 'cancelled';
    await finishAttempt(pool, attempt.id, 'unknown', { error: message });
    await settleApproval(pool, action, 'unknown', { attempt: attempt.attempt, reason, error: message });
    await emitActionEvent(
      pool,
      'effect.unknown',
      { actionId: action.id, tool: action.tool, attempt: attempt.attempt, timeoutMs: deadline },
      action.conversationId,
    );
    return { ok: false, state: 'unknown', reason, message, attempt: attempt.attempt };
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
  if (state === 'executing' || state === 'succeeded' || state === 'failed' || state === 'refused') {
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
 * `refused` carrying the reason, and never goes back to `approved`.
 *
 * `refused` rather than `failed` is the whole distinction: `failed` means the
 * effect was dispatched and threw, and for an irreversible effect that is a
 * state the owner has to go and check. This one certainly did not happen — the
 * body changed, the tool moved, the hash no longer matches — and saying so in
 * the state means a reader does not have to open the outcome to find out.
 */
async function settleWithoutDispatch(
  pool: Queryable,
  action: ActionRecord,
  reason:
    | 'args-hash-mismatch'
    | 'unknown-tool'
    | 'invalid-args'
    | 'effect-changed'
    | 'policy-version-mismatch'
    | 'tier-not-executable',
  detail: Record<string, unknown> & { message: string },
): Promise<ExecuteApprovedResult> {
  await settleApproval(pool, action, 'refused', { reason, ...detail });
  await emitActionEvent(
    pool,
    'effect.refused',
    { actionId: action.id, tool: action.tool, reason, message: detail.message },
    action.conversationId,
  );
  return { ok: false, state: 'refused', reason, message: detail.message };
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
  state: 'succeeded' | 'failed' | 'refused' | 'unknown',
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
  controller: AbortController,
  signal: AbortSignal,
): Promise<{ kind: 'ok'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' } | { kind: 'cancelled' }> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: () => void;
  const cancelled = new Promise<{ kind: 'cancelled' }>((resolve) => {
    onAbort = () => resolve({ kind: 'cancelled' });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' });
      controller.abort(new Error('effect deadline exceeded'));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const work = Promise.resolve().then(run).then(
    (value) => ({ kind: 'ok', value }) as const,
    (error) => ({ kind: 'error', error }) as const,
  );
  try {
    return await Promise.race([work, timeout, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
    if (timer) clearTimeout(timer);
    // The effect may still be in flight: whatever it does, it must not become
    // an unhandled rejection after the deadline decided the outcome.
    void work.catch(() => {});
  }
}
