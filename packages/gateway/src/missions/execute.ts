/**
 * Mission execution: the bridge between the core scheduler and the runtime.
 *
 * Core owns *when* a mission runs; it never imports the runtime. This is the
 * layer above, where "run the agent and decide whether to speak" lives:
 *
 *   fresh conversation -> runAgent(mission.prompt) -> mission.report? -> notify
 *
 * Three rules matter here. The agent id is resolved through the agent catalog —
 * the files under `agents/` — and an unknown id fails closed; it is never
 * coerced into whichever agent happens to be the default. Delivery has no
 * fallback destination: if no owner chat is paired, a scheduled run is a
 * *failure* (the occurrence is marked failed by the runner and no retry is
 * invented in v1), while an explicitly inline run reports the skip and still
 * hands back the text. And **silence is the default**: an unattended run
 * delivers only what it deliberately passed to `mission.report` (see
 * `report.ts`), unless the mission is flagged `always_deliver` — the weekly
 * recap, which the owner asked for whatever the week looked like.
 */
import {
  appendEvent,
  getAction,
  markFindingDelivered,
  offerActions,
  SCHEDULED_SURFACE,
  ToolRegistry,
  UnknownAgentError,
  type ActionRecord,
  type AgentCatalog,
  type Mission,
  type Occurrence,
  type Offer,
  type CoreToolContext,
} from '@buddi/core';
import {
  createConversation,
  runAgent,
  type ApprovalResume,
  type RuntimeProvider,
} from '@buddi/runtime';
import { nativeSearchRecorder } from '@buddi/tool-web';
import type { Pool } from 'pg';
import { gatewayCatalog, memoryPreambleFor } from '../agents/catalog.js';
import { OwnerNotPairedError } from '../telegram/notify.js';
import {
  createMissionManifest,
  NOTIFY_POLICY_SUFFIX,
  type DecisionSink,
  type MissionDecision,
} from './report.js';
import { findingOf, renderFinding, type FindingPayload } from './sentinel-wake.js';

/** Re-exported so callers keep catching the error they always caught. */
export { UnknownAgentError };

/**
 * What is true about being a *scheduled* run, and nothing else.
 *
 * Everything about rendering — plain text, no tables, nobody to answer you —
 * used to be restated here and is now `SCHEDULED_SURFACE`, the profile this
 * executor passes to the run. What survives is the one thing a surface profile
 * cannot say: this run does not answer, it *decides*, by calling `mission.report`
 * or `mission.silent`. Presentation and procedure only: it changes no tool, tier
 * or authorization, and it is not persisted with the agent.
 */
export const SCHEDULED_RUN_SUFFIX = [
  'This is a scheduled run you started on the clock, not a reply to anything the owner said.',
  'Lead with the verdict, then the numbers it rests on.',
  NOTIFY_POLICY_SUFFIX,
].join(' ');

/**
 * Sends the recap somewhere and returns where it went.
 *
 * The second argument is the set of actions the report offered, already stored
 * and carrying ids. A delivery implementation renders them for *its own*
 * surface — `renderOffers` reads the profile and decides between controls and
 * words — so this signature says nothing about buttons and never has to.
 */
export type Deliver = (text: string, offers?: readonly Offer[]) => Promise<string>;

/**
 * Context a mission's prompt picks up just before it runs, and what to commit
 * once its message has actually reached the owner.
 *
 * The weekly digest is the reason this exists: the recap prompt gains the items
 * the watchers noted during the week, and they are marked consumed only after
 * delivery — a recap that failed to send leaves them pending.
 */
export interface PreparedRun {
  appendix: string;
  commit?: () => Promise<void>;
}

/**
 * `finding` is there for a wake run: the watcher that woke this mission knows
 * things the mission's own prompt cannot, and a `prepare` that can see it can
 * put them in front of the agent — the mail watchers hand over the conversation
 * the finding is about (docs/email.md §7).
 */
export type PrepareRun = (
  mission: Mission,
  finding?: FindingPayload | null,
) => Promise<PreparedRun | null>;

/**
 * Several `prepare`s as one: every appendix that applies, in order, and every
 * commit chained behind them. Nothing applying is still `null`, so the run's
 * prompt is untouched.
 */
export function composePrepare(...prepares: readonly PrepareRun[]): PrepareRun {
  return async (mission, finding) => {
    const parts: string[] = [];
    const commits: Array<() => Promise<void>> = [];
    for (const prepare of prepares) {
      const prepared = await prepare(mission, finding);
      if (!prepared) continue;
      if (prepared.appendix.trim() !== '') parts.push(prepared.appendix);
      if (prepared.commit) commits.push(prepared.commit);
    }
    if (parts.length === 0 && commits.length === 0) return null;
    return {
      appendix: parts.join('\n\n'),
      ...(commits.length === 0
        ? {}
        : {
            commit: async () => {
              for (const commit of commits) await commit();
            },
          }),
    };
  };
}

export interface MissionExecutorDeps {
  pool: Pool;
  registry: ToolRegistry;
  provider: RuntimeProvider;
  providerFor?: (agent: ReturnType<AgentCatalog['resolve']>) => RuntimeProvider;
  ctx: CoreToolContext;
  env: NodeJS.ProcessEnv;
  /** Defaults to the catalog loaded from `agents/` for this environment. */
  catalog?: AgentCatalog;
  now: () => Date;
  /** Defaults to `notifyOwner` over Telegram. Injected in tests. */
  deliver: Deliver;
  /**
   * When false, an unpaired owner chat is reported rather than thrown — the
   * `--inline` path, which still wants the text on stdout.
   */
  requireDelivery?: boolean;
  /**
   * Enforce the notify policy (default true). False is for a run the owner
   * asked for *interactively* — `/recap` in Telegram — where the answer belongs
   * in the chat whatever the agent decided.
   */
  notifyPolicy?: boolean;
  prepare?: PrepareRun;
  /**
   * How the owner is asked about a gated call this run proposed. A scheduled
   * run has no chat of its own, so the request is posted on its behalf — with
   * the preview the tool rendered and buttons bound to that one action. Absent:
   * the action is still recorded and still waits for `/approvals`.
   */
  askApproval?: (action: ActionRecord) => Promise<void>;
  log?: (line: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

export type MissionDecisionKind = 'report' | 'silent' | 'no-decision';

/**
 * How a *durable* run is threaded through the executor.
 *
 * A mission run started by a queue job is resumable: it may stop on an approval
 * and come back, minutes or hours later, in a different process. Two things
 * have to cross that gap, and they are exactly these — the job the run belongs
 * to (so a gated call records it on the action, and the decision can find the
 * run again) and, on the way back, the conversation plus the decision itself.
 *
 * An inline run passes neither: nothing about it is durable, and a gated call
 * inside it belongs to no job.
 */
export interface MissionRunControl {
  signal?: AbortSignal;
  /** The durable job this run belongs to. Recorded on any action it proposes. */
  jobId?: string;
  /** Continue the run that suspended on an approval, in its own conversation. */
  resume?: { conversationId: string; approval: ApprovalResume };
}

/** What the run is waiting for, when it stopped instead of finishing. */
export interface AwaitingApproval {
  actionId: string;
  conversationId: string;
}

export interface MissionRunResult {
  conversationId: string;
  text: string;
  /** True once the text reached a chat. */
  delivered: boolean;
  /** What the run decided to do about notifying the owner. */
  decision: MissionDecisionKind;
  /** Present when the run reported. */
  urgency?: 'urgent' | 'normal';
  /** Present when the run stayed silent — the agent's reason, or 'no-decision'. */
  reason?: string;
  /** Where it went, when it went somewhere. */
  chatId?: string;
  /** Why delivery was skipped, when `requireDelivery` is false. */
  skipped?: string;
  /**
   * Set when the run stopped on a gated call instead of finishing. Nothing was
   * delivered and no decision was taken: the caller suspends and comes back.
   */
  awaiting?: AwaitingApproval;
  /**
   * The actions the report offered, stored and ready to bind. Handed back so a
   * caller that prints rather than delivers — `--inline` — can render them for
   * *its* surface instead of being told what Telegram did with them.
   */
  offers?: readonly Offer[];
}

/**
 * A registry for one run: everything installed, plus the two mission tools
 * bound to *this* run's decision. Built per run on purpose — a decision is run
 * state, and the process-wide registry must never carry it.
 */
function registryForRun(base: ToolRegistry, sink: DecisionSink): ToolRegistry {
  const registry = new ToolRegistry();
  for (const manifest of base.manifests()) registry.register(manifest);
  registry.register(createMissionManifest(sink));
  return registry;
}

const MISSION_TOOLS = ['mission.report', 'mission.silent'];

/** Build the `execute` callback `runScheduler` calls. */
export function createMissionExecutor(
  deps: MissionExecutorDeps,
): (
  occurrence: Occurrence,
  mission: Mission,
  control?: MissionRunControl,
) => Promise<MissionRunResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const requireDelivery = deps.requireDelivery !== false;
  const notifyPolicy = deps.notifyPolicy !== false;

  const catalog = deps.catalog ?? gatewayCatalog(deps.env);

  return async function execute(occurrence, mission, control): Promise<MissionRunResult> {
    // Fails closed with UnknownAgentError: a mission naming an agent this
    // install does not carry is a configuration problem, not a fallback.
    const finding = findingOf(occurrence.payload);
    const agentId = finding?.agentId || mission.agentId;
    const selectedAgent = catalog.resolve(agentId);
    const base = selectedAgent.definition(deps.now(), deps.ctx.timezone);
    // The mission tools exist for this run only; the agent's own file never
    // needs to know about them, and nothing outside a mission run can call them.
    const agent = { ...base, tools: [...base.tools, ...MISSION_TOOLS] };

    const sink: DecisionSink = {};
    const registry = registryForRun(deps.registry, sink);

    const prepared = deps.prepare ? await deps.prepare(mission, finding) : null;
    const userMessage = [
      mission.prompt,
      finding ? renderFinding(finding) : '',
      prepared?.appendix ?? '',
    ]
      .filter((part) => part.trim() !== '')
      .join('\n\n');

    // A resumed run continues in the conversation it suspended in; the decision
    // arrives as its opening turn. A fresh run gets a fresh conversation.
    const conversationId =
      control?.resume?.conversationId ?? (await createConversation(deps.pool, agentId));
    log(
      control?.resume
        ? `mission ${mission.id}: occurrence ${occurrence.id} resumed in conversation ${conversationId} (action ${control.resume.approval.actionId} ${control.resume.approval.state})`
        : `mission ${mission.id}: occurrence ${occurrence.id} -> conversation ${conversationId}`,
    );

    // The job rides on the tool context: a gated call records it on the action,
    // and that is the only way the owner's decision later finds this run.
    const ctx: CoreToolContext = {
      ...deps.ctx,
      ...(control?.jobId ? { jobId: control.jobId } : {}),
      ...(control?.signal ? { signal: control.signal } : {}),
    };

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
      ...(control?.resume
        ? { resume: control.resume.approval }
        : { userMessage }),
      surface: SCHEDULED_SURFACE,
      systemSuffix: SCHEDULED_RUN_SUFFIX,
      memoryPreamble: memoryPreambleFor(deps.pool),
      ...(deps.onToolCall ? { onToolCall: deps.onToolCall } : {}),
    });

    // The run proposed a gated effect and stopped. Nothing is decided, nothing
    // is delivered and nothing is silent: the caller parks the job and the
    // owner's answer brings the run back exactly here.
    if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
      log(
        `mission ${mission.id}: awaiting approval on action ${result.pendingActionId} (conversation ${conversationId})`,
      );
      // Asking must never fail the run: the action is recorded and the caller
      // is about to park the job whatever Telegram says.
      if (deps.askApproval) {
        try {
          const action = await getAction(deps.pool, result.pendingActionId);
          control?.signal?.throwIfAborted();
          if (action) await deps.askApproval(action);
        } catch (err) {
          log(
            `mission ${mission.id}: could not post the approval request: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return {
        conversationId,
        text: result.text.trim(),
        delivered: false,
        decision: 'no-decision',
        awaiting: { actionId: result.pendingActionId, conversationId },
      };
    }

    const decision: MissionDecision | undefined = sink.decision;
    const kind: MissionDecisionKind =
      decision?.kind === 'report' ? 'report' : decision?.kind === 'silent' ? 'silent' : 'no-decision';
    const text = (decision?.kind === 'report' ? decision.text : result.text).trim();

    // `always_deliver` is the mission saying the owner asked for this message
    // whatever it says; `notifyPolicy: false` is an interactive run, where the
    // surface shows the answer regardless.
    const forced = mission.alwaysDeliver || !notifyPolicy;
    if (!forced && kind !== 'report') {
      const reason = decision?.kind === 'silent' ? decision.reason : 'no-decision';
      if (kind === 'no-decision') {
        log(
          `mission ${mission.id}: warning — the run ended without calling mission.report or mission.silent; treating as silent`,
        );
      }
      await appendEvent(
        deps.pool,
        'mission.silent',
        {
          missionId: mission.id,
          occurrenceId: occurrence.id,
          conversationId,
          reason,
          ...(finding ? { findingKey: finding.key } : {}),
        },
        conversationId,
      );
      return { conversationId, text, delivered: false, decision: kind, reason };
    }

    if (text === '') throw new Error(`mission "${mission.id}" produced no text to deliver`);

    // The offers are stored *before* delivery, so the ids a button binds to
    // exist whatever the transport then does. A stored offer nobody ever taps
    // is inert; a button bound to an id that was never written is not.
    const offers = await storeOffers(deps, decision, mission.agentId, conversationId);

    let chatId: string | undefined;
    try {
      control?.signal?.throwIfAborted();
      chatId = await deps.deliver(text, offers);
    } catch (err) {
      if (!requireDelivery && err instanceof OwnerNotPairedError) {
        log(`mission ${mission.id}: delivery skipped — ${err.message}`);
        return {
          conversationId,
          text,
          delivered: false,
          decision: kind,
          skipped: err.message,
          ...(offers.length > 0 ? { offers } : {}),
          ...(decision?.kind === 'report' ? { urgency: decision.urgency } : {}),
        };
      }
      throw err;
    }

    await appendEvent(
      deps.pool,
      'mission.delivered',
      {
        missionId: mission.id,
        occurrenceId: occurrence.id,
        conversationId,
        chars: text.length,
        decision: kind,
        ...(decision?.kind === 'report' ? { urgency: decision.urgency } : {}),
        ...(finding ? { findingKey: finding.key } : {}),
      },
      conversationId,
    );

    // The finding actually reached the owner; the watcher's ledger says so.
    if (finding) {
      await markFindingDelivered(deps.pool, finding.key, deps.now()).catch((err: unknown) =>
        log(
          `mission ${mission.id}: could not stamp finding ${finding.key}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    // Only now is the digest consumed: a recap that never sent keeps its items.
    if (prepared?.commit) await prepared.commit();

    return {
      conversationId,
      text,
      delivered: true,
      decision: kind,
      ...(offers.length > 0 ? { offers } : {}),
      ...(decision?.kind === 'report' ? { urgency: decision.urgency } : {}),
      ...(chatId ? { chatId } : {}),
    };
  };
}

export type { FindingPayload };

/**
 * Persist the actions a report offered, if it offered any.
 *
 * Failing to store an offer must never cost the owner the report: a button is
 * a convenience and the text is the message. So this logs and returns nothing
 * rather than throwing — the owner gets prose, which is what they got before.
 */
export async function storeOffers(
  deps: Pick<MissionExecutorDeps, 'pool' | 'now' | 'log'>,
  decision: MissionDecision | undefined,
  agentId: string,
  conversationId: string,
): Promise<Offer[]> {
  if (decision?.kind !== 'report' || decision.actions.length === 0) return [];
  try {
    return await offerActions(deps.pool, {
      agentId,
      conversationId,
      actions: decision.actions,
      now: deps.now(),
    });
  } catch (err) {
    (deps.log ?? ((line: string) => console.error(line)))(
      `offers: could not store the actions this report offered: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}
