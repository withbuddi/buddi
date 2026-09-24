/**
 * Approvals over Telegram — the surface half of the authorization boundary.
 *
 * ARCHITECTURE.md, "Owner and surface authentication": *«Approval callbacks are
 * bound: a callback resolves exactly the pending action it references, from the
 * owner identity. A plain message saying "yes" never resolves anything.»*
 *
 * That sentence is the whole design of this file:
 *
 *  - The only thing that decides an action is an inline-keyboard callback whose
 *    `callback_data` names the action id. There is no text command that
 *    approves, no "yes", no "ok", no reply-to-approve.
 *  - The sender is re-authenticated against core on every callback — a paired
 *    owner identity, in the chat that identity is bound to. A stranger's tap is
 *    recorded as `surface.rejected` and answered with nothing useful.
 *  - The decision itself is core's atomic transition. This module never reads a
 *    state and then writes one; it asks core to move the row, and renders
 *    whatever core says happened.
 *  - Execution follows approval through the Executor, and the run that was
 *    waiting is resumed through the queue's documented interface.
 *
 * The preview shown to the owner is the one stored on the action, rendered by
 * the tool before the approval existed — never model-written text.
 */
import {
  decideApproval,
  executeApproved,
  getAction,
  listPendingActions,
  localDateString,
  resolveOwnerForSurface,
  resumeJobForAction,
  type ActionRecord,
  type ApprovalState,
  type Decision,
  type JobControl,
  type Queryable,
  type CoreToolContext,
  type ToolRegistry,
  type PermissionScope,
  type OwnerChoice,
  conversationGroup,
} from '@buddi/core';
import {
  MAX_CALLBACK_DATA_BYTES,
  type InlineKeyboardMarkup,
  type TelegramApi,
  type TelegramUpdate,
} from './api.js';
import { SURFACE } from './surface.js';
import { waitingDelegation } from '../agents/delegation-chain.js';

/** The prefix every approval callback carries. Short: 64 bytes is the ceiling. */
export const CALLBACK_PREFIX = 'apr';

/** The worker id recorded on an action claimed by a Telegram decision. */
export const TELEGRAM_WORKER = 'telegram-approval';

export type CallbackQuery = NonNullable<TelegramUpdate['callback_query']>;

/**
 * `apr:<actionId>:<approve|reject|conversation|always>`, or `apr:<id>:o<N>` for
 * "approve with option N of the first declared choice".
 *
 * The option travels as an **index into the stored list**, never as the value
 * itself. Two reasons, and both are the same reason: 64 bytes is the whole
 * budget for callback data, and an address does not reliably fit — and a
 * payload that carried the value would be a string from the outside world
 * arriving at the decision path, which is exactly what "the owner can only pick
 * among options the envelope listed" exists to prevent. An index is resolved
 * against the action's own declared list, server side, or it resolves to
 * nothing at all.
 */
export function approvalCallbackData(actionId: string, decision: 'approve' | 'reject' | 'conversation' | 'always' | `o${number}`): string {
  const data = `${CALLBACK_PREFIX}:${actionId}:${decision}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    // A uuid keeps this well under the limit; anything that does not is a bug
    // worth failing on rather than silently truncating into another action's id.
    throw new Error(`approval callback data is too long for Telegram: ${data.length} bytes`);
  }
  return data;
}

export interface ParsedCallback {
  actionId: string;
  decision: Decision;
  permissionScope?: PermissionScope;
  /**
   * Which option of the action's first declared choice was tapped, when the
   * button was an "Approve as …" one. Resolved to a value against the stored
   * action, never trusted as one.
   */
  optionIndex?: number;
}

/**
 * Parse a callback payload, or return nothing.
 *
 * Strict on purpose: the action id must be a uuid, because the id is the whole
 * binding between a tap and the effect it authorizes. Anything else is not an
 * approval callback and is treated as if it had never arrived.
 */
export function parseApprovalCallback(data: string | undefined): ParsedCallback | undefined {
  const m = /^apr:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(approve|reject|conversation|always|o[0-9]{1,2})$/i.exec(
    (data ?? '').trim(),
  );
  if (!m) return undefined;
  const verb = (m[2] as string).toLowerCase();
  const option = /^o([0-9]{1,2})$/.exec(verb);
  return {
    actionId: (m[1] as string).toLowerCase(),
    decision: verb === 'reject' ? 'rejected' : 'approved',
    ...(['conversation', 'always'].includes(verb) ? { permissionScope: verb as PermissionScope } : {}),
    ...(option ? { optionIndex: Number(option[1]) } : {}),
  };
}

/**
 * How many "Approve as …" buttons one keyboard may carry.
 *
 * Four, because a Telegram keyboard is read on a phone and a fifth row of
 * near-identical buttons stops being a choice and becomes a wall. Past it the
 * message offers the default and says plainly that the rest are on the
 * dashboard — the owner is not silently given fewer options than exist.
 */
export const MAX_CHOICE_BUTTONS = 4;

/** The first declared choice, which is the one the keyboard can express. */
export function keyboardChoice(action: Pick<ActionRecord, 'choices'>): OwnerChoice | undefined {
  return action.choices?.[0];
}

/** The line under the preview when the keyboard could not offer everything. */
export function choiceOverflowLine(choice: OwnerChoice): string | undefined {
  if (choice.options.length <= MAX_CHOICE_BUTTONS) return undefined;
  const rest = choice.options.filter((o) => o !== choice.default);
  return `${choice.label}: this approves as ${choice.default}. The other ${rest.length} (${rest.join(', ')}) are on the dashboard.`;
}

export function approvalKeyboard(
  actionId: string,
  host = false,
  choice?: OwnerChoice | undefined,
): InlineKeyboardMarkup {
  /*
   * An approval that offers the owner something offers it as buttons: one
   * "Approve as <option>" per option, one per row so the whole value is
   * readable. Past `MAX_CHOICE_BUTTONS` only the default is offered and
   * `choiceOverflowLine` says where the rest are, rather than showing four of
   * seven aliases as though they were all of them.
   */
  // The standing-permission row, when this tool offers one. Kept out of both
  // branches below rather than written twice: nothing declares choices *and*
  // a reusable approval today, and the day something does, the capability must
  // not vanish because the keyboard took the other branch.
  const scopes = host
    ? [[
        { text: 'Auto: conversation', callback_data: approvalCallbackData(actionId, 'conversation') },
        { text: 'Always: this agent', callback_data: approvalCallbackData(actionId, 'always') },
      ]]
    : [];

  if (choice) {
    const options =
      choice.options.length <= MAX_CHOICE_BUTTONS ? choice.options : [choice.default];
    return {
      inline_keyboard: [
        ...options.map((option) => [
          {
            text: `✅ Approve as ${option}`,
            callback_data: approvalCallbackData(actionId, `o${choice.options.indexOf(option)}`),
          },
        ]),
        [{ text: '✖ Reject', callback_data: approvalCallbackData(actionId, 'reject') }],
        ...scopes,
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: host ? '✅ Allow once' : '✅ Approve', callback_data: approvalCallbackData(actionId, 'approve') },
        { text: '✖ Reject', callback_data: approvalCallbackData(actionId, 'reject') },
      ],
      ...scopes,
    ],
  };
}

/** Takes the buttons away: a decided approval must not be tappable again. */
export const NO_KEYBOARD: InlineKeyboardMarkup = { inline_keyboard: [] };

/**
 * The message the owner is asked to decide.
 *
 * Every line comes from the stored action: the tool that will run, the preview
 * the tool rendered, and when the request stops standing.
 */
export function approvalRequestText(action: ActionRecord, timezone: string): string {
  const choice = keyboardChoice(action);
  const overflow = choice ? choiceOverflowLine(choice) : undefined;
  return [
    `Approval needed — ${action.tool}`,
    '',
    action.preview,
    ...(overflow ? ['', overflow] : []),
    '',
    // No `@`: Telegram links `@name` in bot text to a Telegram user that does
    // not exist, and tapping it errors. The agent is named plainly instead.
    `Asked by ${action.agentId}. Expires ${localDateString(action.expiresAt, timezone)}.`,
    `Action ${action.id}`,
  ].join('\n');
}

/** What replaces the request once it is decided. */
export function decidedText(action: ActionRecord, state: ApprovalState, detail?: string): string {
  const head =
    state === 'rejected'
      ? `Rejected — ${action.tool}`
      : state === 'succeeded'
        ? `Approved and done — ${action.tool}`
        : state === 'failed'
          ? `Approved, but it failed — ${action.tool}`
          // Refused before dispatch: nothing was attempted, so this must not
          // fall through to "Approved". The tool's own sentence arrives in
          // `detail` and says what changed.
          : state === 'refused'
            ? `Not sent — ${action.tool} was refused`
            : state === 'unknown'
              ? `Approved, outcome unknown — ${action.tool}`
              : `Approved — ${action.tool}`;
  return [head, '', action.preview, ...(detail ? ['', detail] : []), '', `Action ${action.id}`].join(
    '\n',
  );
}

/** `/approvals` — what is still waiting, oldest first. */
export function pendingText(actions: readonly ActionRecord[], timezone: string): string {
  if (actions.length === 0) return 'Nothing is waiting for your approval.';
  return [
    'Waiting for you:',
    ...actions.map(
      (a) =>
        `• ${a.tool} — ${firstLine(a.preview)}\n  expires ${localDateString(a.expiresAt, timezone)}\n  ${a.id}`,
    ),
    '',
    'Tap Approve or Reject on the message for one, or ask me to show it again.',
  ].join('\n');
}

function firstLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

export interface ApprovalsOptions {
  resumeInteractive?: (chatId: string, action: ActionRecord, outcome: { actionId: string; state: ApprovalState; result?: unknown }) => Promise<void>;
  api: Pick<TelegramApi, 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'>;
  pool: Queryable;
  /** Needed to execute an approved action; the Executor looks tools up in it. */
  registry: ToolRegistry;
  /** The context an approved effect runs with. */
  ctx: CoreToolContext;
  timezone: string;
  /**
   * The queue, when this build has one wired. Absent: a decision is still
   * recorded and executed, it simply wakes nothing.
   */
  jobs?: JobControl;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * The approval surface for Telegram: post a request, handle a tap, list what is
 * pending. It owns no state of its own — every fact lives in core.
 */
export class TelegramApprovals {
  readonly #opts: ApprovalsOptions;
  readonly #log: (line: string) => void;

  constructor(opts: ApprovalsOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? ((line) => console.error(line));
  }

  #now(): Date {
    return (this.#opts.now ?? (() => new Date()))();
  }

  /** Post a pending action to the owner's chat, buttons attached. */
  async request(chatId: string, action: ActionRecord): Promise<number | undefined> {
    return this.#opts.api.sendMessage(
      chatId,
      approvalRequestText(action, this.#opts.timezone),
      {
        replyMarkup: approvalKeyboard(
          action.id,
          action.tool === 'host.exec',
          keyboardChoice(action),
        ),
      },
    );
  }

  /** `/approvals`. */
  async pending(): Promise<string> {
    const actions = await listPendingActions(this.#opts.pool, { now: this.#now() });
    return pendingText(actions, this.#opts.timezone);
  }

  /**
   * One inline-keyboard tap.
   *
   * Authenticate, decide, execute, wake the run, and only then say anything.
   * The order matters: nothing is shown as decided before core says it is.
   */
  async handleCallback(query: CallbackQuery): Promise<void> {
    const api = this.#opts.api;
    const pool = this.#opts.pool;
    const userId = query.from?.id === undefined ? '' : String(query.from.id);
    const chatId = query.message?.chat?.id === undefined ? '' : String(query.message.chat.id);
    const messageId = query.message?.message_id;

    const parsed = parseApprovalCallback(query.data);
    if (!parsed || userId === '' || chatId === '') {
      // Not ours, or not enough to authenticate: answer the spinner, say
      // nothing, do nothing.
      await api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    // Identity is re-established from core on every tap. A callback is not
    // trusted because it arrived on a chat that was once paired.
    const resolution = await resolveOwnerForSurface(pool, {
      surface: SURFACE,
      externalUserId: userId,
      externalChatId: chatId,
    });
    if (!resolution.ok) {
      this.#log(
        `telegram: approval callback rejected (${resolution.reason}) from user ${userId} in chat ${chatId}`,
      );
      await appendRejected(pool, {
        reason: resolution.reason,
        externalUserId: userId,
        externalChatId: chatId,
        callbackId: query.id,
        actionId: parsed.actionId,
      });
      // A stranger learns nothing: no text, no alert, just a stopped spinner.
      await api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    /*
     * The tapped option, resolved into a value here rather than carried as one.
     * The index is looked up in the action's own declared list.
     *
     * An index that does not resolve is **refused outright**, never quietly
     * degraded into a plain approve. `o7` on a two-option action, an option tap
     * on an action that declares no choices, a tap on an action that no longer
     * exists: each of those means the keyboard the owner was looking at is not
     * the action this payload names, and approving the default because the
     * lookup came back empty would be authorizing something they did not tap.
     * Nothing moves and the owner is told to look at the message again.
     */
    let ownerChoices: Record<string, string> | undefined;
    if (parsed.optionIndex !== undefined) {
      const action = await getAction(pool, parsed.actionId);
      const choice = action ? keyboardChoice(action) : undefined;
      const value = choice?.options[parsed.optionIndex];
      if (!action || !choice || value === undefined) {
        this.#log(
          `telegram: option callback ${query.data} does not resolve against action ${parsed.actionId}; refusing`,
        );
        await api
          .answerCallbackQuery(query.id, 'That button no longer matches this request. Open it again.')
          .catch(() => {});
        return;
      }
      ownerChoices = { [choice.key]: value };
    }

    const decision = await decideApproval(pool, {
      actionId: parsed.actionId,
      decision: parsed.decision,
      by: resolution.ownerId,
      via: SURFACE,
      now: this.#now(),
      permissionScope: parsed.permissionScope,
      registry: this.#opts.registry,
      ...(ownerChoices ? { ownerChoices } : {}),
    });

    if (!decision.ok) {
      const action = await getAction(pool, parsed.actionId);
      await api.answerCallbackQuery(query.id, decision.message).catch(() => {});
      if (action && messageId !== undefined) {
        await this.#edit(chatId, messageId, decidedText(action, action.state, decision.message));
      }
      return;
    }

    const action = decision.action;

    if (parsed.decision === 'rejected') {
      await api.answerCallbackQuery(query.id, 'Rejected.').catch(() => {});
      if (messageId !== undefined) {
        await this.#edit(chatId, messageId, decidedText(action, 'rejected'));
      }
      await this.#wake(action, { state: 'rejected' });
      // A colleague's approval inside a delegation: the agent that asked is
      // owed the rejection as its answer, and that continues on the dashboard.
      if (!action.jobId && await this.#delegated(action)) {
        await this.#opts.resumeInteractive?.(chatId, action, { actionId: action.id, state: 'rejected' });
      }
      return;
    }

    // Approved. The Executor is the only thing that runs it, and it claims the
    // action atomically — so a second worker, or a second tap, cannot double it.
    await api.answerCallbackQuery(query.id, 'Approved — running it now.').catch(() => {});
    if (messageId !== undefined) {
      await this.#edit(chatId, messageId, decidedText(action, 'approved', 'Running it now…'));
    }

    const outcome = await executeApproved(pool, {
      actionId: action.id,
      registry: this.#opts.registry,
      ctx: this.#opts.ctx,
      worker: TELEGRAM_WORKER,
      now: this.#now(),
    });

    const state: ApprovalState = outcome.ok ? 'succeeded' : outcome.state;
    const detail = outcome.ok ? undefined : outcome.message;
    if (messageId !== undefined) {
      await this.#edit(chatId, messageId, decidedText(action, state, detail));
    }
    await this.#wake(action, {
      state,
      ...(outcome.ok ? { result: outcome.result } : { error: outcome.message }),
    });
    if (action.tool === 'host.exec' && !action.jobId && outcome.ok &&
        (outcome.result as { state?: string })?.state === 'completed') {
      await this.#opts.resumeInteractive?.(chatId, action, { actionId: action.id, state, result: outcome.result });
    } else if (!action.jobId && action.conversationId && (await conversationGroup(pool, action.conversationId).catch(() => null) || await this.#delegated(action))) {
      // A group's member was waiting on this. The room resumes on its own
      // path whatever the tool was; the surface only hands the decision on.
      await this.#opts.resumeInteractive?.(chatId, action, { actionId: action.id, state, ...(outcome.ok ? { result: outcome.result } : {}) });
    }
  }

  /** Whether a delegation is paused on this action, with its asker waiting. */
  async #delegated(action: ActionRecord): Promise<boolean> {
    if (!action.conversationId) return false;
    return (await waitingDelegation(this.#opts.pool, action.conversationId).catch(() => null)) !== null;
  }

  /** Wake the suspended run, if there is one. Never fails the decision. */
  async #wake(
    action: ActionRecord,
    outcome: { state: ApprovalState; result?: unknown; error?: string },
  ): Promise<void> {
    try {
      const what = await resumeJobForAction(this.#opts.pool, this.#opts.jobs, action, outcome);
      if (what === 'no-queue' && action.jobId !== null) {
        this.#log(
          `telegram: action ${action.id} belongs to job ${action.jobId}, but no queue is wired into this process`,
        );
      }
    } catch (err) {
      this.#log(
        `telegram: resuming job ${action.jobId} for action ${action.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Edits are cosmetic: a failed one is logged, never allowed to undo a decision. */
  async #edit(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.#opts.api.editMessageText(chatId, messageId, text, {
        replyMarkup: NO_KEYBOARD,
      });
    } catch (err) {
      this.#log(
        `telegram: editing approval message ${messageId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function appendRejected(
  pool: Queryable,
  payload: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, null, $2::jsonb)`,
    ['surface.rejected', JSON.stringify({ surface: SURFACE, kind: 'callback', ...payload })],
  );
}
