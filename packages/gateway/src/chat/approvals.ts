/**
 * Approvals in the terminal.
 *
 * The rule from ARCHITECTURE.md does not change because the surface did: the
 * owner decides, core moves the row, and the Executor is the only thing that
 * runs the effect. So this file is deliberately thin — it calls exactly the
 * functions the Telegram surface calls, in exactly the same order:
 *
 *   decideApproval → executeApproved → resumeJobForAction
 *
 * and it borrows Telegram's own renderers (`approvalRequestText`, `decidedText`,
 * `pendingText`) rather than writing a second vocabulary for the same facts.
 *
 * Nothing here auto-approves. `y` at the prompt is a keystroke the owner made,
 * bound to one action id; a model cannot produce one.
 */
import {
  decideApproval,
  executeApproved,
  getAction,
  listPendingActions,
  resumeJob,
  resumeJobForAction,
  type ActionRecord,
  type ApprovalState,
  type Decision,
  type Queryable,
  type ToolContext,
  type ToolRegistry,
  type PermissionScope,
} from '@buddi/core';
import type { ApprovalResume } from '@buddi/runtime';
import { decidedText, pendingText } from '../telegram/approvals.js';

/** The surface name recorded on a decision made here. */
export const SURFACE = 'cli';

/** The worker id recorded on an action claimed by a terminal decision. */
export const CLI_WORKER = 'cli-approval';

export interface CliApprovalsOptions {
  pool: Queryable;
  registry: ToolRegistry;
  ctx: ToolContext;
  timezone: string;
  /** The owner identity a decision is recorded against. */
  ownerId: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface DecisionOutcome {
  /** What to print. Already a finished sentence. */
  text: string;
  /**
   * How the *inline* run continues, when the action belongs to no queue job.
   * A run started at this prompt is not durable: nothing else will wake it, so
   * the session feeds this back into `runAgent` itself. An action carrying a
   * job id is left to the queue, exactly as a Telegram decision is.
   */
  resume?: ApprovalResume;
}

/** What `/approvals` says when the id does not name anything pending. */
export function noSuchPendingText(id: string): string {
  return `Nothing pending matches "${id}". Send /approvals to see what is waiting.`;
}

/** An abbreviation that matched more than one pending action. */
export function ambiguousText(id: string, matches: readonly string[]): string {
  return [`"${id}" matches ${matches.length} pending actions:`, ...matches.map((m) => `  ${m}`)].join(
    '\n',
  );
}

/**
 * What the session needs from the approval machinery: a list, an id, and a
 * decision. Structural on purpose — the same reason the Telegram surface takes
 * `ApprovalHooks` — so a build with no approvals wired, and a test, can satisfy
 * it without reaching into core.
 */
export interface ApprovalPort {
  /** The `/approvals` answer, already rendered. */
  pending(): Promise<string>;
  /** A full id for what the owner typed, or the sentence to print instead. */
  resolveId(input: string): Promise<{ ok: true; id: string } | { ok: false; text: string }>;
  /** Decide one action: approve runs it through the Executor, reject does not. */
  decide(actionId: string, decision: Decision, scope?: PermissionScope): Promise<DecisionOutcome>;
}

export class CliApprovals implements ApprovalPort {
  readonly #opts: CliApprovalsOptions;
  readonly #log: (line: string) => void;

  constructor(opts: CliApprovalsOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? ((line) => console.error(line));
  }

  #now(): Date {
    return (this.#opts.now ?? ((): Date => new Date()))();
  }

  /** `/approvals`, rendered the way Telegram renders it. */
  async pending(): Promise<string> {
    const actions = await listPendingActions(this.#opts.pool, { now: this.#now() });
    return pendingText(actions, this.#opts.timezone);
  }

  /**
   * The full id for what the owner typed.
   *
   * A uuid is not something anyone retypes, so a prefix is accepted — but only
   * an unambiguous one, and only against what is actually pending. The id stays
   * the whole binding between a keystroke and the effect it authorizes.
   */
  async resolveId(input: string): Promise<
    { ok: true; id: string } | { ok: false; text: string }
  > {
    const wanted = input.trim().toLowerCase();
    if (wanted === '') return { ok: false, text: 'Send /approve <id> — /approvals lists them.' };
    const actions = await listPendingActions(this.#opts.pool, { now: this.#now() });
    const matches = actions.map((a) => a.id).filter((id) => id.toLowerCase().startsWith(wanted));
    if (matches.length === 1) return { ok: true, id: matches[0] as string };
    if (matches.length > 1) return { ok: false, text: ambiguousText(input, matches) };
    // Not pending — but it may exist and be already decided, which is a more
    // useful thing to be told than "no such action".
    const action = await getAction(this.#opts.pool, wanted);
    if (action) return { ok: true, id: action.id };
    return { ok: false, text: noSuchPendingText(input) };
  }

  /**
   * Decide one action. Approve runs it through the Executor; reject does not.
   * Either way the suspended run is told, here or through the queue.
   */
  async decide(actionId: string, decision: Decision, scope: PermissionScope = 'once'): Promise<DecisionOutcome> {
    const pool = this.#opts.pool;
    const result = await decideApproval(pool, {
      actionId,
      decision,
      by: this.#opts.ownerId,
      via: SURFACE,
      now: this.#now(),
      permissionScope: scope,
      registry: this.#opts.registry,
    });

    if (!result.ok) {
      const action = await getAction(pool, actionId);
      return {
        text: action ? decidedText(action, action.state, result.message) : result.message,
      };
    }

    const action = result.action;

    if (decision === 'rejected') {
      await this.#wake(action, { state: 'rejected' });
      return {
        text: decidedText(action, 'rejected'),
        ...(action.jobId === null
          ? { resume: { actionId: action.id, state: 'rejected' } }
          : {}),
      };
    }

    const outcome = await executeApproved(pool, {
      actionId: action.id,
      registry: this.#opts.registry,
      ctx: this.#opts.ctx,
      worker: CLI_WORKER,
      now: this.#now(),
    });
    const state: ApprovalState = outcome.ok ? 'succeeded' : outcome.state;
    const detail = outcome.ok ? undefined : outcome.message;
    await this.#wake(action, {
      state,
      ...(outcome.ok ? { result: outcome.result } : { error: outcome.message }),
    });

    return {
      text: decidedText(action, state, detail),
      ...(action.jobId === null
        ? {
            resume: {
              actionId: action.id,
              state,
              ...(outcome.ok ? { result: outcome.result } : { error: outcome.message }),
            },
          }
        : {}),
    };
  }

  /** Wake a *durable* run through the queue. Never fails the decision. */
  async #wake(
    action: ActionRecord,
    outcome: { state: ApprovalState; result?: unknown; error?: string },
  ): Promise<void> {
    if (action.jobId === null) return;
    try {
      await resumeJobForAction(this.#opts.pool, { resumeJob }, action, outcome);
    } catch (err) {
      this.#log(
        `cli: resuming job ${action.jobId} for action ${action.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
