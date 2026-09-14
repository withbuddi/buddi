#!/usr/bin/env node
/**
 * `buddi-telegram` — the Telegram surface process (roadmap step 2).
 *
 * Wiring only: resolve the provider once, register the finance plugin, pair the
 * allowlisted owner id if the environment names one, then long-poll. Every
 * authorization decision belongs to core; every tool call belongs to the
 * registry. This file decides nothing.
 *
 * `startTelegram` is the reusable half: `buddi serve` starts the same surface
 * next to the scheduler in one process, sharing one pool and one provider.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureOwner,
  getAction,
  getSurfaceCursor,
  listSurfaceIdentities,
  pairSurfaceIdentity,
  resumeJob,
  type JobControl,
  type SurfaceIdentity,
  type ToolContext,
  type ToolRegistry,
} from '@buddi/core';
import { runAgent, type RunAgentOptions, type RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { memoryPreambleFor } from '../agents/catalog.js';
import { createWiringAsync, loadEnv } from '../bootstrap.js';
import { TelegramApprovals } from './approvals.js';
import { TelegramApi, type TelegramBotCommand } from './api.js';
import { createCoreArtifactStore, type ArtifactStore } from './attachments.js';
import {
  SURFACE,
  SURFACE_HINT,
  TelegramSurface,
  handleLabel,
  type RunMission,
} from './surface.js';
import type { AgentCatalog } from './types.js';

/**
 * The command menu, shown only to paired owner chats.
 *
 * Telegram resolves a menu from the narrowest scope outward. buddi clears the
 * *default* scope and publishes this list per paired chat, so a stranger who
 * opens the bot sees no menu at all — the same fail-closed posture the surface
 * takes with messages.
 */
export const OWNER_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'agents', description: 'List the agents you can talk to' },
  { command: 'use', description: 'Switch agent' },
  { command: 'status', description: 'Where you stand right now' },
  { command: 'recap', description: 'Run the weekly recap now' },
  { command: 'reminders', description: 'What the agents put on the clock' },
  { command: 'approvals', description: 'Anything waiting for your approval' },
  { command: 'files', description: 'The last files you sent me' },
  { command: 'devices', description: 'Devices paired to this installation' },
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'id', description: 'Show my Telegram ids' },
  { command: 'help', description: 'What buddi can do' },
];

/**
 * The menu as one chat sees it: `use` names the agent that chat is talking to
 * — `Switch agent (active: Ledger)` — so the active agent is visible without
 * asking. No `@`: that spelling is reserved for what the owner types, because
 * Telegram renders it as a link to a user who does not exist.
 */
export function ownerCommandsFor(activeAgentHandle?: string): readonly TelegramBotCommand[] {
  const label = handleLabel(activeAgentHandle);
  if (label === '') return OWNER_COMMANDS;
  return OWNER_COMMANDS.map((c) =>
    c.command === 'use' ? { ...c, description: `Switch agent (active: ${label})` } : c,
  );
}

/**
 * Publish the owner menu for every paired chat and clear the default scope.
 * Cosmetic: a Bot API failure is logged and never stops the surface starting.
 */
export async function applyCommandMenus(
  api: Pick<TelegramApi, 'setMyCommands' | 'deleteMyCommands'>,
  paired: readonly SurfaceIdentity[],
  log: (line: string) => void,
  activeAgentHandle?: (chatId: string) => Promise<string | undefined>,
): Promise<void> {
  try {
    await api.deleteMyCommands({ type: 'default' });
  } catch (err) {
    log(`telegram: clearing the default command menu failed: ${errorText(err)}`);
  }
  for (const identity of paired) {
    const chatId = identity.externalChatId;
    if (!chatId) continue;
    let handle: string | undefined;
    if (activeAgentHandle) {
      handle = await activeAgentHandle(chatId).catch((err) => {
        log(`telegram: active agent for chat ${chatId} unknown: ${errorText(err)}`);
        return undefined;
      });
    }
    try {
      await api.setMyCommands(ownerCommandsFor(handle), { type: 'chat', chat_id: chatId });
      log(`telegram: menu set for chat ${chatId}`);
    } catch (err) {
      log(`telegram: menu for chat ${chatId} failed: ${errorText(err)}`);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What the chat is told when a run stops on an approval and the model said
 * nothing else. The request itself arrives as its own message, with buttons.
 */
export const AWAITING_APPROVAL_REPLY =
  'I need your approval before I can do that — see the request just below.';

/** Numeric ids only: a username is not an identity. */
export function numericId(value: string | undefined, label: string): string | undefined {
  const raw = (value ?? '').trim();
  if (raw === '') return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} must be a numeric id, got: ${raw}`);
  }
  return raw;
}

export interface TelegramDeps {
  pool: Pool;
  registry: ToolRegistry;
  /** Every installed agent. One bot, many agents; the chat picks with /use. */
  catalog: AgentCatalog;
  provider: RuntimeProvider;
  ctx: ToolContext;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** Injected in tests; built from `TELEGRAM_BOT_TOKEN` otherwise. */
  api?: TelegramApi;
  /** Injected in tests; bound to core's artifact store otherwise. */
  artifacts?: ArtifactStore;
  log?: (line: string) => void;
  /**
   * Runs a mission inline for `/recap`. `buddi serve` owns the executor and
   * passes it; the standalone surface has no scheduler and leaves it out.
   */
  runMission?: RunMission;
  /**
   * The queue, for waking a run that suspended awaiting an approval. Defaults
   * to core's own `resumeJob`; a build with no queue passes `null`.
   */
  jobs?: JobControl | null;
  /**
   * Asked before every interactive turn. A string is the answer the owner gets
   * *instead of* a run — `buddi serve` uses it for the global pause, so a paused
   * installation says so rather than quietly doing the work anyway. Null means
   * carry on. Absent: nothing is gated.
   */
  gate?: () => Promise<string | null>;
}

export interface TelegramHandle {
  botUsername: string | undefined;
  botId: number;
  /**
   * The approval surface this process runs. Exposed so an *unattended* run —
   * a scheduled mission, a source's run — can ask the owner too: the run has
   * no chat of its own, but the request must still arrive with buttons bound
   * to the one action it authorizes.
   */
  approvals: TelegramApprovals;
  /** Owner identities paired for this surface at startup. */
  paired: SurfaceIdentity[];
  /** The persisted polling offset as it stood at startup. */
  cursor: string | undefined;
  /** Resolves when polling has stopped and every queued run has drained. */
  done: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start the Telegram surface. Returns once the bot identity is known and
 * polling has begun; the caller owns the pool and decides when to stop.
 */
export async function startTelegram(deps: TelegramDeps): Promise<TelegramHandle> {
  const { pool, env, now } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!deps.api && token === '') throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const api = deps.api ?? new TelegramApi({ token });

  await ensureOwner(pool, 'owner');

  const ownerUserId = numericId(env.TELEGRAM_OWNER_USER_ID, 'TELEGRAM_OWNER_USER_ID');
  const ownerChatId = numericId(env.TELEGRAM_OWNER_CHAT_ID, 'TELEGRAM_OWNER_CHAT_ID');
  if (ownerUserId) {
    // The startup allowlist. `paired_via` is recorded, and core keeps the
    // first value, so a device that paired by code is never relabelled 'env'.
    await pairSurfaceIdentity(pool, {
      surface: SURFACE,
      externalUserId: ownerUserId,
      externalChatId: ownerChatId ?? ownerUserId,
      pairedVia: 'env',
    });
  }

  const paired = await listSurfaceIdentities(pool, SURFACE);
  const cursor = await getSurfaceCursor(pool, SURFACE);
  const me = await api.getMe();

  const setChatMenu = async (chatId: string, agent: { handle: string }): Promise<void> => {
    await api.setMyCommands(ownerCommandsFor(agent.handle), { type: 'chat', chat_id: chatId });
  };

  // Files land in core's artifact store; the surface only hands bytes over and
  // asks for them back when a run needs to look at one.
  const artifacts = deps.artifacts ?? createCoreArtifactStore({ pool, env });

  // Approvals: the surface routes a tap here, and every decision, execution and
  // resume happens inside core. The queue is wired in so a decided action wakes
  // the run that was suspended waiting for it.
  const jobs = deps.jobs === null ? undefined : (deps.jobs ?? { resumeJob });
  const approvals = new TelegramApprovals({
    api,
    pool,
    registry: deps.registry,
    ctx: deps.ctx,
    timezone: deps.ctx.timezone,
    ...(jobs ? { jobs } : {}),
    log,
    now,
  });

  const surface = new TelegramSurface({
    api,
    pool,
    catalog: deps.catalog,
    timezone: deps.ctx.timezone,
    // The bot's own @username, so Telegram's mention of it is stripped before
    // the owner's `@handle` is read.
    ...(me.username ? { botUsername: me.username } : {}),
    artifacts,
    log,
    setChatMenu,
    ...(deps.runMission ? { runMission: deps.runMission } : {}),
    approvals,
    // The surface decided *which* agent this turn belongs to; resolving the id
    // again here is what makes the definition current (`{{today}}`, a reloaded
    // file) without letting the wiring choose a different agent.
    run: async ({ conversationId, chatId, text, agent, attachments, onToolCall }) => {
      // Interactive turns stay inline — they are user-facing and already
      // serialized per chat — but they are not exempt from a global pause.
      const blocked = deps.gate ? await deps.gate() : null;
      if (blocked !== null) return blocked;

      const options: RunAgentOptions = {
        agent: deps.catalog.resolve(agent.id).definition(now(), deps.ctx.timezone),
        provider: deps.provider,
        registry: deps.registry,
        ctx: deps.ctx,
        pool,
        conversationId,
        userMessage: text,
        systemSuffix: SURFACE_HINT,
        memoryPreamble: memoryPreambleFor(pool),
        onToolCall: (name, input) => {
          log(`⚙ ${name} ${JSON.stringify(input)}`);
          onToolCall?.(name, input);
        },
      };
      // Multimodal input is the runtime's business: the surface says *which*
      // artifacts this turn may see and how to fetch one, and never builds a
      // provider content block itself.
      if (attachments && attachments.length > 0) {
        options.attachments = attachments;
        options.loadArtifact = (id) => artifacts.load(id);
      }
      const result = await runAgent(options);

      // The run proposed a gated effect and stopped. The owner is asked in this
      // same chat, with the preview the *tool* rendered and buttons bound to
      // that one action — no message here can approve anything by itself.
      if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
        const action = await getAction(pool, result.pendingActionId);
        if (action) await approvals.request(chatId, action);
        return result.text.trim() === '' ? AWAITING_APPROVAL_REPLY : result.text;
      }
      return result.text;
    },
  });

  // Only paired chats get a menu; strangers see none. Each chat's menu names
  // the agent that chat is talking to.
  await applyCommandMenus(api, paired, log, async (chatId) =>
    (await surface.activeAgent(chatId)).handle,
  );

  surface.offset = cursor === undefined ? undefined : Number(cursor);

  const done = surface.start();

  return {
    botUsername: me.username ?? undefined,
    botId: me.id,
    approvals,
    paired,
    cursor,
    done,
    async stop(): Promise<void> {
      surface.stop();
      await done;
    },
  };
}

/** How the startup banner renders a paired identity list. */
export function describePaired(paired: readonly SurfaceIdentity[]): string {
  if (paired.length === 0) {
    return 'none — messages will be ignored until TELEGRAM_OWNER_USER_ID is set';
  }
  return paired
    .map((p) => `${p.externalUserId}${p.externalChatId ? `@chat:${p.externalChatId}` : ''}`)
    .join(', ');
}

export async function main(): Promise<void> {
  loadEnv();

  let wiring;
  try {
    wiring = await createWiringAsync(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    const handle = await startTelegram({
      pool: wiring.pool,
      registry: wiring.registry,
      catalog: wiring.catalog,
      provider: wiring.provider,
      ctx: wiring.ctx,
      env: process.env,
      now: wiring.now,
    });

    console.log(`buddi telegram surface`);
    console.log(`  bot: @${handle.botUsername ?? '(unknown)'} (id ${handle.botId})`);
    console.log(`  paired owner ids: ${describePaired(handle.paired)}`);
    console.log(`  last cursor: ${handle.cursor ?? '(none)'}`);
    console.log(`  model: ${wiring.model} (${wiring.credentialKind})`);
    if (wiring.secrets) {
      const sources = Object.entries(wiring.secrets.sources)
        .map(([name, source]) => `${name}<-${source}`)
        .join(', ');
      console.log(`  vault: ${wiring.secrets.vault}${sources ? ` (${sources})` : ''}`);
    }

    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: stopping telegram surface…`);
      void handle.stop();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await handle.done;
    console.log('telegram surface stopped cleanly');
  } finally {
    await wiring.pool.end();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
