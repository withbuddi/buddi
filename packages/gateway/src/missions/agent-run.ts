/**
 * `agent-run` — the job a **source** originates.
 *
 * A mission run starts because a cron said so. This one starts because the
 * world changed: mail landed, a file appeared, a watcher polled. There is no
 * mission and no occurrence behind it — only an agent id, a prompt and a dedup
 * key that the source chose — so it gets its own job kind rather than being
 * forced into a mission's shape.
 *
 * Everything else is deliberately the same as a scheduled run, because the
 * owner's experience of it is the same:
 *
 *  - **The agent is resolved through the catalog** and an unknown id fails
 *    closed. A source cannot name its way into a different agent's tools.
 *  - **Silence is the default.** The run ends by calling `mission.report` or
 *    `mission.silent` — the very tools in `report.ts`, registered for this run
 *    only — and a run that calls neither delivers nothing.
 *  - **An approval suspends the job, durably.** The gated call records this job
 *    on the action; the job is parked with what it is waiting for written into
 *    its own payload; the owner's tap resumes it and the run continues in the
 *    same conversation, with the decision delivered as a late tool result.
 */
import {
  appendEvent,
  getAction,
  getOffer,
  SCHEDULED_SURFACE,
  ToolRegistry,
  type ActionRecord,
  type AgentCatalog,
  type JobHandler,
  type Suspension,
  type ToolContext,
} from '@buddi/core';
import {
  createConversation,
  runAgent,
  type ApprovalResume,
  type RuntimeProvider,
} from '@buddi/runtime';
import { nativeSearchRecorder } from '@buddi/tool-web';
import type { Pool } from 'pg';
import { memoryPreambleFor } from '../agents/catalog.js';
import { OwnerNotPairedError } from '../telegram/notify.js';
import { SCHEDULED_RUN_SUFFIX, storeOffers, type Deliver } from './execute.js';
import { createMissionManifest, type DecisionSink, type MissionDecision } from './report.js';

/** The kind a source's run is queued under. */
export const AGENT_RUN_JOB_KIND = 'agent-run';

/** The conversation hint a run started by a tapped offer carries. */
export const OFFER_HINT_PREFIX = 'offer:';

/**
 * What changes when the owner *asked* for this run by tapping something.
 *
 * Everything else about an unattended run still holds — nobody is at the
 * keyboard to answer a question, the text is delivered as a notification — but
 * the default flips. Silence is right for a watcher that found nothing; it is
 * wrong for a run the owner started with their thumb ten seconds ago, where
 * saying nothing reads as a broken button.
 *
 * It changes no tool and no tier. An effect this run proposes travels the same
 * approval, with the same preview, as it would have without the tap.
 */
export const OFFER_RUN_SUFFIX = [
  'The owner started this run themselves, by choosing one of the actions you offered on an earlier report.',
  'So end with mission.report, not mission.silent: they are waiting to see what came of it.',
  'Nothing about the tap authorizes anything — it saved them typing the sentence, and no more.',
].join(' ');

/** The mission tools, added to the agent's own for this run only. */
const MISSION_TOOLS = ['mission.report', 'mission.silent'];

/** What a source put on the queue, plus what the run wrote back on itself. */
export interface AgentRunPayload {
  agentId: string;
  prompt: string;
  /** Free-form routing hint from the source. Recorded, never authoritative. */
  conversationHint?: string;
  /** Written when the run suspends: the action it waits on and where to resume. */
  awaiting?: { actionId: string; conversationId: string };
  /** Merged in by `resumeJobForAction` when the owner decides. */
  approval?: ApprovalResume;
}

/** Read a job payload, or say it is not one. Never guesses a field. */
export function agentRunPayload(payload: unknown): AgentRunPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string' || p.agentId.trim() === '') return null;
  if (typeof p.prompt !== 'string' || p.prompt.trim() === '') return null;
  const awaiting =
    typeof p.awaiting === 'object' && p.awaiting !== null
      ? (p.awaiting as { actionId?: unknown; conversationId?: unknown })
      : null;
  const approval =
    typeof p.approval === 'object' && p.approval !== null
      ? (p.approval as { actionId?: unknown; state?: unknown })
      : null;
  return {
    agentId: p.agentId,
    prompt: p.prompt,
    ...(typeof p.conversationHint === 'string' ? { conversationHint: p.conversationHint } : {}),
    ...(awaiting && typeof awaiting.actionId === 'string' && typeof awaiting.conversationId === 'string'
      ? { awaiting: { actionId: awaiting.actionId, conversationId: awaiting.conversationId } }
      : {}),
    ...(approval && typeof approval.actionId === 'string' && typeof approval.state === 'string'
      ? { approval: approval as unknown as ApprovalResume }
      : {}),
  };
}

export interface AgentRunDeps {
  pool: Pool;
  registry: ToolRegistry;
  catalog: AgentCatalog;
  provider: RuntimeProvider;
  providerFor?: (agent: ReturnType<AgentCatalog['resolve']>) => RuntimeProvider;
  ctx: ToolContext;
  now: () => Date;
  /** Where a `mission.report` goes. Defaults to Telegram in `buddi serve`. */
  deliver: Deliver;
  /**
   * How the owner is asked about a gated call. An unattended run has no chat of
   * its own, so the request has to be posted on its behalf — with the preview
   * the tool rendered and buttons bound to that one action. Absent: the action
   * is still recorded and still waits, the owner simply has to find it with
   * `/approvals`.
   */
  askApproval?: (action: ActionRecord) => Promise<void>;
  log?: (line: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

/** What the handler records as the job's result. */
export interface AgentRunOutcome {
  conversationId: string;
  agentId: string;
  decision: 'report' | 'silent' | 'no-decision';
  delivered: boolean;
  chars: number;
  reason?: string;
  chatId?: string;
  skipped?: string;
}

/**
 * A registry for one run: everything installed, plus the two mission tools
 * bound to *this* run's decision. Per run on purpose — a decision is run state.
 */
function registryForRun(base: ToolRegistry, sink: DecisionSink): ToolRegistry {
  const registry = new ToolRegistry();
  for (const manifest of base.manifests()) registry.register(manifest);
  registry.register(createMissionManifest(sink));
  return registry;
}

export function createAgentRunHandler(deps: AgentRunDeps): JobHandler {
  const log = deps.log ?? ((line: string) => console.error(line));

  return async function handle(job, jobContext): Promise<unknown | Suspension> {
    jobContext.signal?.throwIfAborted();
    const payload = agentRunPayload(job.payload);
    if (!payload) {
      throw new Error(`agent-run job ${job.id}: payload is not an agent run`);
    }

    // Fails closed with UnknownAgentError: a source naming an agent this
    // installation does not carry is a configuration problem, not a fallback.
    const selectedAgent = deps.catalog.resolve(payload.agentId);
    const base = selectedAgent.definition(deps.now(), deps.ctx.timezone);
    const agent = { ...base, tools: [...base.tools, ...MISSION_TOOLS] };

    const sink: DecisionSink = {};
    const registry = registryForRun(deps.registry, sink);

    // Resuming: the conversation is the one that suspended, and the owner's
    // decision is this run's opening turn. Fresh: a new conversation, the
    // source's prompt — unless the run came from a tapped offer that was made
    // *inside* a conversation, in which case it belongs there. An offer taken
    // from the Offers list or from Telegram used to answer only by
    // notification, and the thread that offered it showed nothing at all.
    const resuming = payload.approval && payload.awaiting;
    const offerConversationId = resuming
      ? null
      : await conversationOfOffer(deps, payload, log);
    const conversationId = resuming
      ? (payload.awaiting as { conversationId: string }).conversationId
      : (offerConversationId ?? (await createConversation(deps.pool, payload.agentId)));

    log(
      resuming
        ? `agent-run ${job.id}: @${payload.agentId} resumed in conversation ${conversationId} (action ${payload.approval?.actionId} ${payload.approval?.state})`
        : `agent-run ${job.id}: @${payload.agentId} -> conversation ${conversationId}`,
    );

    const ctx: ToolContext = { ...deps.ctx, jobId: job.id, signal: jobContext.signal };

    const result = await runAgent({
      agent,
      provider: deps.providerFor ? deps.providerFor(selectedAgent) : deps.provider,
      registry,
      ctx,
      pool: deps.pool,
      // The provider's own web search leaves the same audit row `web.search`
      // does; see @buddi/tool-web's native.ts.
      onNativeSearch: nativeSearchRecorder(deps.pool),
      conversationId,
      ...(resuming
        ? { resume: payload.approval as ApprovalResume }
        : { userMessage: payload.prompt }),
      surface: SCHEDULED_SURFACE,
      systemSuffix: payload.conversationHint?.startsWith(OFFER_HINT_PREFIX)
        ? `${SCHEDULED_RUN_SUFFIX} ${OFFER_RUN_SUFFIX}`
        : SCHEDULED_RUN_SUFFIX,
      memoryPreamble: memoryPreambleFor(deps.pool),
      ...(deps.onToolCall ? { onToolCall: deps.onToolCall } : {}),
    });

    // Stopped on a gated call. Park the job with what it waits for; the tap on
    // the owner's keyboard is what brings it back. No worker, no transaction
    // and no provider call is held in the meantime.
    if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
      log(
        `agent-run ${job.id}: awaiting approval on action ${result.pendingActionId} (conversation ${conversationId})`,
      );
      jobContext.signal?.throwIfAborted();
      await askOwner(deps, result.pendingActionId, log);
      return {
        suspended: `awaiting-approval:${result.pendingActionId}`,
        payloadPatch: {
          awaiting: { actionId: result.pendingActionId, conversationId },
        },
      } satisfies Suspension;
    }

    const decision: MissionDecision | undefined = sink.decision;
    const kind: AgentRunOutcome['decision'] =
      decision?.kind === 'report' ? 'report' : decision?.kind === 'silent' ? 'silent' : 'no-decision';
    const text = (decision?.kind === 'report' ? decision.text : result.text).trim();

    if (kind !== 'report') {
      const reason = decision?.kind === 'silent' ? decision.reason : 'no-decision';
      if (kind === 'no-decision') {
        log(
          `agent-run ${job.id}: warning — the run ended without calling mission.report or mission.silent; treating as silent`,
        );
      }
      await appendEvent(
        deps.pool,
        'mission.silent',
        { agentId: payload.agentId, jobId: job.id, conversationId, reason, source: 'agent-run' },
        conversationId,
      );
      return {
        conversationId,
        agentId: payload.agentId,
        decision: kind,
        delivered: false,
        chars: 0,
        reason,
      } satisfies AgentRunOutcome;
    }

    if (text === '') throw new Error(`agent-run ${job.id}: mission.report produced no text`);

    // Stored before delivery: a button must never be bound to an id that was
    // not written. A store that fails costs the buttons, never the report.
    const offers = await storeOffers(deps, decision, payload.agentId, conversationId);

    // The thread the offer came from hears the answer in its own words. The
    // run already happened *in* this conversation, but what the owner is shown
    // is `mission.report`'s text, and a transcript that carried only the tool
    // call would make a chip taken from the Offers list look unanswered.
    if (offerConversationId) await sayInConversation(deps, offerConversationId, payload.agentId, text, log);

    let chatId: string | undefined;
    try {
      jobContext.signal?.throwIfAborted();
      chatId = await deps.deliver(text, offers);
    } catch (err) {
      // Nobody to tell is not a reason to retry the model. The run happened,
      // the decision stands, and the skip is recorded on the job's result.
      if (err instanceof OwnerNotPairedError) {
        log(`agent-run ${job.id}: delivery skipped — ${err.message}`);
        return {
          conversationId,
          agentId: payload.agentId,
          decision: kind,
          delivered: false,
          chars: text.length,
          skipped: err.message,
        } satisfies AgentRunOutcome;
      }
      throw err;
    }

    await appendEvent(
      deps.pool,
      'mission.delivered',
      {
        agentId: payload.agentId,
        jobId: job.id,
        conversationId,
        chars: text.length,
        decision: kind,
        source: 'agent-run',
        ...(decision?.kind === 'report' ? { urgency: decision.urgency } : {}),
      },
      conversationId,
    );

    return {
      conversationId,
      agentId: payload.agentId,
      decision: kind,
      delivered: true,
      chars: text.length,
      ...(chatId ? { chatId } : {}),
    } satisfies AgentRunOutcome;
  };
}

/**
 * The conversation a tapped offer belongs to, when it has one.
 *
 * Read from the offer row rather than taken from the hint: the hint names an
 * id, and the id is looked up. A row that is gone, carries no conversation, or
 * whose conversation belongs to a different agent falls back to a fresh
 * conversation — a run never lands in somebody else's thread.
 */
async function conversationOfOffer(
  deps: AgentRunDeps,
  payload: AgentRunPayload,
  log: (line: string) => void,
): Promise<string | null> {
  const hint = payload.conversationHint;
  if (!hint?.startsWith(OFFER_HINT_PREFIX)) return null;
  const id = hint.slice(OFFER_HINT_PREFIX.length).trim();
  if (id === '') return null;
  try {
    const offer = await getOffer(deps.pool, id);
    if (!offer?.conversationId) return null;
    const { rows } = await deps.pool.query(
      'select agent_id from core.conversations where id = $1::uuid',
      [offer.conversationId],
    );
    if (rows[0]?.agent_id !== payload.agentId) return null;
    return offer.conversationId;
  } catch (err) {
    log(`agent-run: could not read the offer behind ${hint}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Write the report into the conversation, as the agent saying it.
 *
 * Never allowed to fail the run: the report was produced and is about to be
 * delivered, and a transcript row is how it is *also* read where it was asked
 * for.
 */
async function sayInConversation(
  deps: AgentRunDeps,
  conversationId: string,
  agentId: string,
  text: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await deps.pool.query(
      'insert into core.messages (conversation_id, role, content) values ($1::uuid, $2, $3::jsonb)',
      [conversationId, 'assistant', JSON.stringify([{ type: 'text', text }])],
    );
    // The same event an interactive turn writes, so a page watching this
    // conversation refreshes instead of waiting for the owner to reload.
    await appendEvent(
      deps.pool,
      'chat.message.appended',
      { role: 'assistant', runId: null, agentId, source: 'offer' },
      conversationId,
    );
  } catch (err) {
    log(`agent-run: could not write the report into conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Post the approval request, if this process has a surface to post it on.
 *
 * Never throws into the run: the action is recorded and the job is about to be
 * parked whatever Telegram says, and an approval the owner has to find with
 * `/approvals` is a worse day, not a lost effect.
 */
async function askOwner(
  deps: AgentRunDeps,
  actionId: string,
  log: (line: string) => void,
): Promise<void> {
  if (!deps.askApproval) return;
  try {
    const action = await getAction(deps.pool, actionId);
    if (!action) return;
    await deps.askApproval(action);
  } catch (err) {
    log(
      `agent-run: could not post the approval request for ${actionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
