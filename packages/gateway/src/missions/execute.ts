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
  markFindingDelivered,
  ToolRegistry,
  UnknownAgentError,
  type AgentCatalog,
  type Mission,
  type Occurrence,
  type ToolContext,
} from '@buddi/core';
import { createConversation, runAgent, type RuntimeProvider } from '@buddi/runtime';
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
 * Presentation contract for an unattended run. Presentation only: it changes no
 * tool, tier or authorization, and it is not persisted with the agent.
 */
export const SCHEDULED_RUN_SUFFIX = [
  'Surface: Telegram, scheduled unattended run.',
  'Nobody is at the keyboard: this text is delivered as a notification and cannot be answered.',
  'Never ask the owner a question and never offer to do something on confirmation.',
  'Lead with the verdict, then the numbers it rests on.',
  'Plain text only: no markdown, no tables, no bullets built from pipes. Short lines.',
  NOTIFY_POLICY_SUFFIX,
].join(' ');

/** Sends the recap somewhere and returns where it went. */
export type Deliver = (text: string) => Promise<string>;

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

export type PrepareRun = (mission: Mission) => Promise<PreparedRun | null>;

export interface MissionExecutorDeps {
  pool: Pool;
  registry: ToolRegistry;
  provider: RuntimeProvider;
  ctx: ToolContext;
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
  log?: (line: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

export type MissionDecisionKind = 'report' | 'silent' | 'no-decision';

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
): (occurrence: Occurrence, mission: Mission) => Promise<MissionRunResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const requireDelivery = deps.requireDelivery !== false;
  const notifyPolicy = deps.notifyPolicy !== false;

  const catalog = deps.catalog ?? gatewayCatalog(deps.env);

  return async function execute(occurrence, mission): Promise<MissionRunResult> {
    // Fails closed with UnknownAgentError: a mission naming an agent this
    // install does not carry is a configuration problem, not a fallback.
    const finding = findingOf(occurrence.payload);
    const agentId = finding?.agentId || mission.agentId;
    const base = catalog.resolve(agentId).definition(deps.now(), deps.ctx.timezone);
    // The mission tools exist for this run only; the agent's own file never
    // needs to know about them, and nothing outside a mission run can call them.
    const agent = { ...base, tools: [...base.tools, ...MISSION_TOOLS] };

    const sink: DecisionSink = {};
    const registry = registryForRun(deps.registry, sink);

    const prepared = deps.prepare ? await deps.prepare(mission) : null;
    const userMessage = [
      mission.prompt,
      finding ? renderFinding(finding) : '',
      prepared?.appendix ?? '',
    ]
      .filter((part) => part.trim() !== '')
      .join('\n\n');

    const conversationId = await createConversation(deps.pool, agentId);
    log(
      `mission ${mission.id}: occurrence ${occurrence.id} -> conversation ${conversationId}`,
    );

    const result = await runAgent({
      agent,
      provider: deps.provider,
      registry,
      ctx: deps.ctx,
      pool: deps.pool,
      conversationId,
      userMessage,
      systemSuffix: SCHEDULED_RUN_SUFFIX,
      memoryPreamble: memoryPreambleFor(deps.pool),
      ...(deps.onToolCall ? { onToolCall: deps.onToolCall } : {}),
    });

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

    let chatId: string | undefined;
    try {
      chatId = await deps.deliver(text);
    } catch (err) {
      if (!requireDelivery && err instanceof OwnerNotPairedError) {
        log(`mission ${mission.id}: delivery skipped — ${err.message}`);
        return {
          conversationId,
          text,
          delivered: false,
          decision: kind,
          skipped: err.message,
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
      ...(decision?.kind === 'report' ? { urgency: decision.urgency } : {}),
      ...(chatId ? { chatId } : {}),
    };
  };
}

export type { FindingPayload };
