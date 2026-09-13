/**
 * Mission execution: the bridge between the core scheduler and the runtime.
 *
 * Core owns *when* a mission runs; it never imports the runtime. This is the
 * layer above, where "run the agent and deliver the answer" lives:
 *
 *   fresh conversation -> runAgent(mission.prompt) -> notifyOwner(text)
 *
 * Two rules matter here. The agent id is resolved through the agent catalog —
 * the files under `agents/` — and an unknown id fails closed; it is never
 * coerced into whichever agent happens to be the default. And delivery has no
 * fallback destination: if no owner chat is paired, a scheduled run is a *failure* (the occurrence is
 * marked failed by the runner and no retry is invented in v1), while an
 * explicitly inline run reports the skip and still hands back the text.
 */
import {
  appendEvent,
  UnknownAgentError,
  type AgentCatalog,
  type Mission,
  type Occurrence,
  type ToolContext,
  type ToolRegistry,
} from '@buddi/core';
import { createConversation, runAgent, type RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { gatewayCatalog, memoryPreambleFor } from '../agents/catalog.js';
import { OwnerNotPairedError } from '../telegram/notify.js';

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
].join(' ');

/** Sends the recap somewhere and returns where it went. */
export type Deliver = (text: string) => Promise<string>;

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
  log?: (line: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

export interface MissionRunResult {
  conversationId: string;
  text: string;
  /** True once the text reached a chat. */
  delivered: boolean;
  /** Where it went, when it went somewhere. */
  chatId?: string;
  /** Why delivery was skipped, when `requireDelivery` is false. */
  skipped?: string;
}

/** Build the `execute` callback `runScheduler` calls. */
export function createMissionExecutor(
  deps: MissionExecutorDeps,
): (occurrence: Occurrence, mission: Mission) => Promise<MissionRunResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const requireDelivery = deps.requireDelivery !== false;

  const catalog = deps.catalog ?? gatewayCatalog(deps.env);

  return async function execute(occurrence, mission): Promise<MissionRunResult> {
    // Fails closed with UnknownAgentError: a mission naming an agent this
    // install does not carry is a configuration problem, not a fallback.
    const agent = catalog.resolve(mission.agentId).definition(deps.now());
    const conversationId = await createConversation(deps.pool, mission.agentId);
    log(
      `mission ${mission.id}: occurrence ${occurrence.id} -> conversation ${conversationId}`,
    );

    const result = await runAgent({
      agent,
      provider: deps.provider,
      registry: deps.registry,
      ctx: deps.ctx,
      pool: deps.pool,
      conversationId,
      userMessage: mission.prompt,
      systemSuffix: SCHEDULED_RUN_SUFFIX,
      memoryPreamble: memoryPreambleFor(deps.pool),
      ...(deps.onToolCall ? { onToolCall: deps.onToolCall } : {}),
    });

    const text = result.text.trim();
    if (text === '') throw new Error(`mission "${mission.id}" produced no text to deliver`);

    let chatId: string | undefined;
    try {
      chatId = await deps.deliver(text);
    } catch (err) {
      if (!requireDelivery && err instanceof OwnerNotPairedError) {
        log(`mission ${mission.id}: delivery skipped — ${err.message}`);
        return { conversationId, text, delivered: false, skipped: err.message };
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
      },
      conversationId,
    );

    return { conversationId, text, delivered: true, ...(chatId ? { chatId } : {}) };
  };
}
